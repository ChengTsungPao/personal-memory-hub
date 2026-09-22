# Postgres Store Backend — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a working `"postgres"` store backend that persists and reads back L0 conversations, L1 memories, entity records and audit rows, with tenant isolation pushed into SQL — no search yet.

**Architecture:** A new `MemoryCore/src/core/store/postgres/` directory implementing `IMemoryStore` against one PostgreSQL instance via `pg.Pool`. File layout mirrors `mongodb/` (several small files) rather than `sqlite/` (two very large ones). Vectors live as ordinary `vector(N)` columns on the record rows, so no virtual-table join is needed. The `sqlite`, `tcvdb` and `mongodb` backends are not modified.

**Tech Stack:** TypeScript (ESM, NodeNext), `pg` 8.x, PostgreSQL 17 with `pgvector` 0.8 (`pgvector/pgvector:pg17` image), vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-22-postgres-store-backend-design.md`

## Global Constraints

- Backend id string is exactly `"postgres"` everywhere (config type, factory case, `harness.backend`).
- Never modify `src/core/store/sqlite/`, `src/core/store/tcvdb/`, or `src/core/store/mongodb/`.
- All new files live under `src/core/store/postgres/`; tests are co-located as `*.test.ts` (vitest `include` is `src/**/*.test.ts`).
- Imports use explicit `.js` extensions (the repo is ESM/NodeNext) — e.g. `import { X } from "./schema.js"`.
- Connection config comes from env: `PG_ENDPOINT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `PG_SSL`. Missing `PG_ENDPOINT` or `PG_DATABASE` must throw from the factory.
- Every log/throw string is prefixed with the tag `[memory-tdai][postgres]`.
- Tests run against a **real** Postgres. No mocking of the driver, the planner, or `tsvector`.
- Each test run isolates itself in its own schema named `test_<uuid-with-underscores>`, dropped on teardown.
- Isolation columns (`team_id`, `user_id`, `agent_id`, `task_id`) are `TEXT NOT NULL DEFAULT ''` — matching SQLite's "default to `''` when missing" rule from `L0Record`'s doc comment.
- Phase 1 targets contract cases #1, #2, #3, #9, #10. Case #6 (`isolation pushdown on counts + FTS`) contains an FTS half that lands in Phase 2; Phase 1 covers its count-pushdown half with a dedicated local test (Task 9). *(This is a deliberate refinement of the spec's phase table, which listed #6 under Phase 1.)*

---

### Task 1: Test infrastructure — Docker Postgres, `pg` dependency, schema-isolated harness

**Files:**
- Create: `MemoryCore/src/core/store/postgres/__tests__/docker-compose.postgres.yaml`
- Create: `MemoryCore/src/core/store/postgres/__tests__/test-db.ts`
- Modify: `MemoryCore/package.json` (add `pg`, `@types/pg`, add a `test` script)
- Test: `MemoryCore/src/core/store/postgres/__tests__/test-db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `withTestSchema(): Promise<{ pool: Pool; schema: string; drop: () => Promise<void> }>` — connects using `PG_*` env, creates a unique schema, sets `search_path` to it.
  - `TEST_PG_ENV` — the env object pointing at the compose service, for tests that go through the factory.

- [ ] **Step 1: Add dependencies and a test script**

`MemoryCore/node_modules` does not exist yet and the repo ships **no** lockfile
(no `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`), so install everything
first, with npm. Ignore `MemoryCore/pnpm-workspace.yaml` — there is no
`pnpm-lock.yaml` beside it and the repo root declares no workspace.

```bash
cd MemoryCore
npm install
npm install pg
npm install --save-dev @types/pg
```

Then add to `package.json` `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Write the compose file**

Create `MemoryCore/src/core/store/postgres/__tests__/docker-compose.postgres.yaml`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: memorycore-test-postgres
    environment:
      POSTGRES_USER: memorycore
      POSTGRES_PASSWORD: memorycore
      POSTGRES_DB: memorycore_test
    ports:
      - "55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U memorycore -d memorycore_test"]
      interval: 2s
      timeout: 3s
      retries: 30
```

- [ ] **Step 3: Start it and confirm pgvector is present**

Run:

```bash
docker compose -f MemoryCore/src/core/store/postgres/__tests__/docker-compose.postgres.yaml up -d
docker exec memorycore-test-postgres psql -U memorycore -d memorycore_test \
  -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"
```

Expected: prints an `extversion` of `0.8.x` or higher.

- [ ] **Step 4: Write the failing test**

Create `MemoryCore/src/core/store/postgres/__tests__/test-db.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { withTestSchema } from "./test-db.js";

describe("withTestSchema", () => {
  it("creates an isolated schema and drops it", async () => {
    const a = await withTestSchema();
    const b = await withTestSchema();

    expect(a.schema).not.toBe(b.schema);

    await a.pool.query("CREATE TABLE t (id int)");
    await a.pool.query("INSERT INTO t VALUES (1)");

    // b must not see a's table — separate search_path
    await expect(b.pool.query("SELECT * FROM t")).rejects.toThrow();

    await a.drop();
    await b.drop();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/__tests__/test-db.test.ts`
Expected: FAIL — cannot resolve `./test-db.js`.

- [ ] **Step 6: Implement the harness**

Create `MemoryCore/src/core/store/postgres/__tests__/test-db.ts`:

```ts
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export const TEST_PG_ENV = {
  PG_ENDPOINT: process.env.PG_ENDPOINT ?? "postgres://memorycore:memorycore@127.0.0.1:55432",
  PG_DATABASE: process.env.PG_DATABASE ?? "memorycore_test",
} as const;

export interface TestSchema {
  pool: Pool;
  schema: string;
  drop: () => Promise<void>;
}

/**
 * Connect to the compose Postgres, create a uniquely-named schema, and pin
 * every connection in the returned pool to it via `search_path`.
 */
export async function withTestSchema(): Promise<TestSchema> {
  const schema = `test_${randomUUID().replace(/-/g, "_")}`;
  const connectionString = `${TEST_PG_ENV.PG_ENDPOINT}/${TEST_PG_ENV.PG_DATABASE}`;

  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();

  const pool = new Pool({ connectionString, max: 4 });
  // Every new physical connection lands in the test schema.
  pool.on("connect", (client) => {
    void client.query(`SET search_path TO "${schema}"`);
  });

  const drop = async () => {
    await pool.end();
    const cleanup = new Pool({ connectionString, max: 1 });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
  };

  return { pool, schema, drop };
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/__tests__/test-db.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add MemoryCore/package.json MemoryCore/package-lock.json MemoryCore/src/core/store/postgres/__tests__/
git commit -m "test(postgres): docker compose + schema-isolated test harness"
```

---

### Task 2: `client-pool.ts` — pool construction and pgvector capability probe

**Files:**
- Create: `MemoryCore/src/core/store/postgres/client-pool.ts`
- Test: `MemoryCore/src/core/store/postgres/client-pool.test.ts`

**Interfaces:**
- Consumes: `withTestSchema` from Task 1.
- Produces:
  - `interface PgConfig { endpoint: string; database: string; user?: string; password?: string; ssl?: boolean }`
  - `interface PgProbe { pgvectorVersion: string | null; hasSparsevec: boolean }`
  - `createPgPool(config: PgConfig): Pool`
  - `probeCapabilities(pool: Pool): Promise<PgProbe>` — runs `CREATE EXTENSION IF NOT EXISTS vector`, then reads `pg_extension.extversion`; `hasSparsevec` is true when the version is ≥ 0.7.0.
  - `readPgEnvConfig(): PgConfig` — reads the `PG_*` vars; throws when `PG_ENDPOINT` or `PG_DATABASE` is missing.

- [ ] **Step 1: Write the failing test**

Create `MemoryCore/src/core/store/postgres/client-pool.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { probeCapabilities, readPgEnvConfig } from "./client-pool.js";

let db: TestSchema;
afterEach(async () => { await db?.drop(); });

describe("probeCapabilities", () => {
  it("reports the installed pgvector version and sparsevec support", async () => {
    db = await withTestSchema();
    const probe = await probeCapabilities(db.pool);

    expect(probe.pgvectorVersion).toMatch(/^\d+\.\d+/);
    expect(probe.hasSparsevec).toBe(true); // pg17 image ships pgvector >= 0.8
  });
});

describe("readPgEnvConfig", () => {
  it("throws when PG_ENDPOINT is missing", () => {
    vi.stubEnv("PG_ENDPOINT", "");
    vi.stubEnv("PG_DATABASE", "db");
    expect(() => readPgEnvConfig()).toThrow(/PG_ENDPOINT/);
  });

  it("throws when PG_DATABASE is missing", () => {
    vi.stubEnv("PG_ENDPOINT", "postgres://localhost:5432");
    vi.stubEnv("PG_DATABASE", "");
    expect(() => readPgEnvConfig()).toThrow(/PG_DATABASE/);
  });
});
```

Add `vi` to the import list from `vitest`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/client-pool.test.ts`
Expected: FAIL — cannot resolve `./client-pool.js`.

- [ ] **Step 3: Implement `client-pool.ts`**

```ts
import { Pool } from "pg";

const TAG = "[memory-tdai][postgres]";

export interface PgConfig {
  endpoint: string;
  database: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface PgProbe {
  /** e.g. "0.8.0", or null when the extension could not be created. */
  pgvectorVersion: string | null;
  /** True when pgvector >= 0.7.0, which is when `sparsevec` appeared. */
  hasSparsevec: boolean;
}

export function readPgEnvConfig(): PgConfig {
  const endpoint = process.env.PG_ENDPOINT?.trim();
  const database = process.env.PG_DATABASE?.trim();
  if (!endpoint) throw new Error(`${TAG} PG_ENDPOINT is required`);
  if (!database) throw new Error(`${TAG} PG_DATABASE is required`);
  return {
    endpoint,
    database,
    user: process.env.PG_USER?.trim() || undefined,
    password: process.env.PG_PASSWORD?.trim() || undefined,
    ssl: process.env.PG_SSL?.trim() === "true",
  };
}

export function createPgPool(config: PgConfig): Pool {
  return new Pool({
    connectionString: `${config.endpoint}/${config.database}`,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
}

/** Compare dotted version strings: returns true when `v` >= `min`. */
function atLeast(v: string, min: string): boolean {
  const a = v.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export async function probeCapabilities(pool: Pool): Promise<PgProbe> {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch {
    // No rights to install it, or it is unavailable on this server.
    return { pgvectorVersion: null, hasSparsevec: false };
  }
  const { rows } = await pool.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  const version = rows[0]?.extversion ?? null;
  return {
    pgvectorVersion: version,
    hasSparsevec: version ? atLeast(version, "0.7.0") : false,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/client-pool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add MemoryCore/src/core/store/postgres/client-pool.ts MemoryCore/src/core/store/postgres/client-pool.test.ts
git commit -m "feat(postgres): connection pool + pgvector capability probe"
```

---

### Task 3: `schema.ts` — idempotent DDL for L0 and L1

**Files:**
- Create: `MemoryCore/src/core/store/postgres/schema.ts`
- Test: `MemoryCore/src/core/store/postgres/schema.test.ts`

**Interfaces:**
- Consumes: `PgProbe` from Task 2.
- Produces: `ensureSchema(pool: Pool, opts: { dimensions: number; probe: PgProbe }): Promise<void>` — creates `l0_conversations`, `l1_records`, their indexes, and `embedding_meta`. Safe to call repeatedly. Adds `vector(dimensions)` columns only when `probe.pgvectorVersion` is non-null and `dimensions > 0`.

- [ ] **Step 1: Write the failing test**

Create `MemoryCore/src/core/store/postgres/schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { probeCapabilities } from "./client-pool.js";
import { ensureSchema } from "./schema.js";

let db: TestSchema;
afterEach(async () => { await db?.drop(); });

describe("ensureSchema", () => {
  it("creates l0/l1 tables and is idempotent", async () => {
    db = await withTestSchema();
    const probe = await probeCapabilities(db.pool);

    await ensureSchema(db.pool, { dimensions: 4, probe });
    await ensureSchema(db.pool, { dimensions: 4, probe }); // second call must not throw

    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [db.schema],
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toContain("l0_conversations");
    expect(names).toContain("l1_records");
    expect(names).toContain("embedding_meta");
  });

  it("gives isolation columns a non-null empty default", async () => {
    db = await withTestSchema();
    const probe = await probeCapabilities(db.pool);
    await ensureSchema(db.pool, { dimensions: 0, probe });

    await db.pool.query(
      `INSERT INTO l0_conversations (record_id, session_key, session_id, role, message_text, recorded_at, timestamp)
       VALUES ('r1', 'sk', 'sid', 'user', 'hello', now()::text, 1)`,
    );
    const { rows } = await db.pool.query<{ team_id: string; user_id: string }>(
      "SELECT team_id, user_id FROM l0_conversations WHERE record_id = 'r1'",
    );
    expect(rows[0]).toEqual({ team_id: "", user_id: "" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/schema.test.ts`
Expected: FAIL — cannot resolve `./schema.js`.

- [ ] **Step 3: Implement `schema.ts`**

```ts
import type { Pool } from "pg";
import type { PgProbe } from "./client-pool.js";

export interface EnsureSchemaOptions {
  /** Embedding dimensions; 0 means "no vector columns yet". */
  dimensions: number;
  probe: PgProbe;
}

/**
 * Create every Phase-1 table and index. Idempotent: safe on every init().
 *
 * Isolation columns are TEXT NOT NULL DEFAULT '' to match the SQLite backend,
 * whose upsert defaults missing tenancy fields to '' (see L0Record doc).
 */
export async function ensureSchema(pool: Pool, opts: EnsureSchemaOptions): Promise<void> {
  const { dimensions, probe } = opts;
  const wantVectors = dimensions > 0 && probe.pgvectorVersion !== null;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS embedding_meta (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS l0_conversations (
      record_id    TEXT PRIMARY KEY,
      session_key  TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      team_id      TEXT NOT NULL DEFAULT '',
      user_id      TEXT NOT NULL DEFAULT '',
      agent_id     TEXT NOT NULL DEFAULT '',
      task_id      TEXT NOT NULL DEFAULT '',
      role         TEXT NOT NULL,
      message_text TEXT NOT NULL,
      tokens       TEXT NOT NULL DEFAULT '',
      recorded_at  TEXT NOT NULL,
      timestamp    BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS l1_records (
      record_id       TEXT PRIMARY KEY,
      content         TEXT NOT NULL,
      tokens          TEXT NOT NULL DEFAULT '',
      type            TEXT NOT NULL,
      priority        INTEGER NOT NULL DEFAULT 0,
      scene_name      TEXT NOT NULL DEFAULT '',
      session_key     TEXT NOT NULL DEFAULT '',
      session_id      TEXT NOT NULL DEFAULT '',
      team_id         TEXT NOT NULL DEFAULT '',
      user_id         TEXT NOT NULL DEFAULT '',
      agent_id        TEXT NOT NULL DEFAULT '',
      task_id         TEXT NOT NULL DEFAULT '',
      version         INTEGER NOT NULL DEFAULT 1,
      timestamp_str   TEXT NOT NULL DEFAULT '',
      timestamp_start TEXT NOT NULL DEFAULT '',
      timestamp_end   TEXT NOT NULL DEFAULT '',
      created_time    TEXT NOT NULL,
      updated_time    TEXT NOT NULL,
      metadata_json   TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_l0_session            ON l0_conversations (session_key);
    CREATE INDEX IF NOT EXISTS idx_l0_session_id         ON l0_conversations (session_id);
    CREATE INDEX IF NOT EXISTS idx_l0_task               ON l0_conversations (task_id);
    CREATE INDEX IF NOT EXISTS idx_l0_team_agent         ON l0_conversations (team_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_l0_recorded           ON l0_conversations (recorded_at);
    CREATE INDEX IF NOT EXISTS idx_l0_timestamp          ON l0_conversations (timestamp);
    CREATE INDEX IF NOT EXISTS idx_l0_user_agent_session ON l0_conversations (user_id, agent_id, session_id);

    CREATE INDEX IF NOT EXISTS idx_l1_type               ON l1_records (type);
    CREATE INDEX IF NOT EXISTS idx_l1_session_key        ON l1_records (session_key);
    CREATE INDEX IF NOT EXISTS idx_l1_session_id         ON l1_records (session_id);
    CREATE INDEX IF NOT EXISTS idx_l1_scene              ON l1_records (scene_name);
    CREATE INDEX IF NOT EXISTS idx_l1_task_updated       ON l1_records (task_id, updated_time);
    CREATE INDEX IF NOT EXISTS idx_l1_team_agent_updated ON l1_records (team_id, agent_id, updated_time);
    CREATE INDEX IF NOT EXISTS idx_l1_user_agent_session ON l1_records (user_id, agent_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_l1_user_updated       ON l1_records (user_id, updated_time);
    CREATE INDEX IF NOT EXISTS idx_l1_agent_updated      ON l1_records (agent_id, updated_time);
  `);

  if (wantVectors) {
    // Separate statements: ALTER ... ADD COLUMN IF NOT EXISTS needs its own round.
    await pool.query(`ALTER TABLE l0_conversations ADD COLUMN IF NOT EXISTS embedding vector(${dimensions})`);
    await pool.query(`ALTER TABLE l1_records       ADD COLUMN IF NOT EXISTS embedding vector(${dimensions})`);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add MemoryCore/src/core/store/postgres/schema.ts MemoryCore/src/core/store/postgres/schema.test.ts
git commit -m "feat(postgres): idempotent DDL for l0/l1 tables and indexes"
```

---

### Task 4: `memory-store.ts` skeleton — `init`, `getCapabilities`, `isDegraded`, `close`

**Files:**
- Create: `MemoryCore/src/core/store/postgres/memory-store.ts`
- Test: `MemoryCore/src/core/store/postgres/memory-store.lifecycle.test.ts`

**Interfaces:**
- Consumes: `createPgPool`, `probeCapabilities`, `PgConfig` (Task 2); `ensureSchema` (Task 3).
- Produces:
  - `interface PostgresMemoryStoreOptions { config: PgConfig; dimensions: number; pool?: Pool; logger?: StoreLogger }`
  - `class PostgresMemoryStore implements IMemoryStore` with `init()`, `isDegraded()`, `getCapabilities()`, `close()`. Later tasks add methods to this same class.

This satisfies contract case #1 (`init → non-degraded + capability shape`).

- [ ] **Step 1: Write the failing test**

Create `MemoryCore/src/core/store/postgres/memory-store.lifecycle.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { PostgresMemoryStore } from "./memory-store.js";

let db: TestSchema;
afterEach(async () => { await db?.drop(); });

describe("PostgresMemoryStore lifecycle", () => {
  it("init() reports non-degraded with the expected capability shape", async () => {
    db = await withTestSchema();
    const store = new PostgresMemoryStore({
      config: { endpoint: "unused", database: "unused" },
      dimensions: 4,
      pool: db.pool,
    });

    const result = await store.init();
    expect(result.needsReindex).toBe(false);
    expect(store.isDegraded()).toBe(false);

    const caps = store.getCapabilities();
    expect(caps.vectorSearch).toBe(true);
    expect(caps.profileRows).toBe(true);
    expect(caps.sparseVectors).toBe(true);
    expect(typeof caps.ftsSearch).toBe("boolean");
    expect(typeof caps.nativeHybridSearch).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.lifecycle.test.ts`
Expected: FAIL — cannot resolve `./memory-store.js`.

- [ ] **Step 3: Implement the skeleton**

```ts
import type { Pool } from "pg";
import type {
  IMemoryStore, StoreCapabilities, StoreInitResult, StoreLogger,
  EmbeddingProviderInfo,
} from "../types.js";
import { createPgPool, probeCapabilities, type PgConfig, type PgProbe } from "./client-pool.js";
import { ensureSchema } from "./schema.js";

const TAG = "[memory-tdai][postgres]";

export interface PostgresMemoryStoreOptions {
  config: PgConfig;
  dimensions: number;
  /** Injected pool (tests). When absent one is built from `config`. */
  pool?: Pool;
  logger?: StoreLogger;
}

export class PostgresMemoryStore implements Partial<IMemoryStore> {
  private readonly pool: Pool;
  private readonly dimensions: number;
  private readonly logger?: StoreLogger;
  private probe: PgProbe = { pgvectorVersion: null, hasSparsevec: false };
  private degraded = true;

  constructor(opts: PostgresMemoryStoreOptions) {
    this.pool = opts.pool ?? createPgPool(opts.config);
    this.dimensions = opts.dimensions;
    this.logger = opts.logger;
  }

  async init(_providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    this.probe = await probeCapabilities(this.pool);
    await ensureSchema(this.pool, { dimensions: this.dimensions, probe: this.probe });
    this.degraded = false;
    this.logger?.debug?.(
      `${TAG} init ok: pgvector=${this.probe.pgvectorVersion ?? "absent"}, ` +
      `sparsevec=${this.probe.hasSparsevec}, dimensions=${this.dimensions}`,
    );
    return { needsReindex: false };
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    const hasVector = this.probe.pgvectorVersion !== null && this.dimensions > 0;
    return {
      vectorSearch: hasVector,
      // Phase 2 turns these on.
      ftsSearch: false,
      nativeHybridSearch: false,
      sparseVectors: this.probe.hasSparsevec,
      // Plain relational tables — no extension needed.
      profileRows: true,
    };
  }

  close(): void {
    void this.pool.end();
  }
}
```

`Partial<IMemoryStore>` is deliberate and **stays that way for all of Phase 1**.
Phase 1 leaves the search methods, the profile-row methods, `reindexAll`,
`isFtsAvailable` and both parent interfaces (`MemoryPromptStore`,
`MemoryGenerationRefStore`) unimplemented, so a full `implements IMemoryStore`
cannot typecheck yet. Phase 3/4 tightens it once the surface is complete; until
then the factory casts (see Task 10).

- [ ] **Step 4: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add MemoryCore/src/core/store/postgres/memory-store.ts MemoryCore/src/core/store/postgres/memory-store.lifecycle.test.ts
git commit -m "feat(postgres): store skeleton with init + capability reporting"
```

---

### Task 5: L0 write, count and session query

**Files:**
- Modify: `MemoryCore/src/core/store/postgres/memory-store.ts`
- Create: `MemoryCore/src/core/store/postgres/isolation-sql.ts`
- Test: `MemoryCore/src/core/store/postgres/memory-store.l0.test.ts`
- Test: `MemoryCore/src/core/store/postgres/isolation-sql.test.ts`

**Interfaces:**
- Consumes: `PostgresMemoryStore` (Task 4).
- Produces:
  - `buildIsolationWhere(filter: IsolationFilter | undefined, startIndex: number): { sql: string; params: string[] }` in `isolation-sql.ts` — returns `""` when nothing to narrow on, else `" AND team_id = $1 AND ..."` with `$n` placeholders starting at `startIndex`.
  - On `PostgresMemoryStore`: `upsertL0(record, embedding?)`, `countL0(filter?)`, `queryL0ForL1(sessionKey, afterRecordedAtMs?, limit?)` returning `L0QueryRow[]`, `deleteL0(recordId, filter?)`, `deleteL0Expired(cutoffIso)`.

This satisfies contract case #2 (`L0 write → count → session query roundtrip`).

**The read method is `queryL0ForL1`, and it keys on `sessionKey` — not `sessionId`.**
Contract case #2 calls `store.queryL0ForL1("sk-contract")`, while its fixture sets
`sessionKey: "sk-contract"` and `sessionId: "sid-contract"`. The signature in
`IMemoryStore` is:

```ts
queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0QueryRow[]>;
```

`afterRecordedAtMs` is an L1-cursor bound on `recorded_at`, used to fetch only
messages newer than the last L1 run.

- [ ] **Step 1: Write the failing test for the isolation helper**

Create `MemoryCore/src/core/store/postgres/isolation-sql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildIsolationWhere } from "./isolation-sql.js";

describe("buildIsolationWhere", () => {
  it("returns empty SQL when the filter narrows nothing", () => {
    expect(buildIsolationWhere(undefined, 1)).toEqual({ sql: "", params: [] });
    expect(buildIsolationWhere({}, 1)).toEqual({ sql: "", params: [] });
  });

  it("emits one clause per set dimension, numbered from startIndex", () => {
    const { sql, params } = buildIsolationWhere({ teamId: "t1", agentId: "a1" }, 3);
    expect(sql).toBe(" AND team_id = $3 AND agent_id = $4");
    expect(params).toEqual(["t1", "a1"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/isolation-sql.test.ts`
Expected: FAIL — cannot resolve `./isolation-sql.js`.

- [ ] **Step 3: Implement `isolation-sql.ts`**

```ts
import type { IsolationFilter } from "../isolation.js";

/** Column order is fixed so generated SQL is stable and index-friendly. */
const COLUMNS: Array<[keyof IsolationFilter, string]> = [
  ["teamId", "team_id"],
  ["userId", "user_id"],
  ["agentId", "agent_id"],
  ["sessionId", "session_id"],
  ["taskId", "task_id"],
  ["sessionKey", "session_key"],
];

/**
 * Build the ` AND col = $n` tail for an isolation filter.
 *
 * An unset field means "do not narrow on this dimension" (see IsolationFilter),
 * so it contributes no clause at all.
 */
export function buildIsolationWhere(
  filter: IsolationFilter | undefined,
  startIndex: number,
): { sql: string; params: string[] } {
  if (!filter) return { sql: "", params: [] };

  const parts: string[] = [];
  const params: string[] = [];
  let n = startIndex;

  for (const [key, column] of COLUMNS) {
    const value = filter[key];
    if (value === undefined) continue;
    parts.push(` AND ${column} = $${n}`);
    params.push(value);
    n += 1;
  }

  return { sql: parts.join(""), params };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/isolation-sql.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing L0 test**

Create `MemoryCore/src/core/store/postgres/memory-store.l0.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { PostgresMemoryStore } from "./memory-store.js";

let db: TestSchema;
let store: PostgresMemoryStore;

beforeEach(async () => {
  db = await withTestSchema();
  store = new PostgresMemoryStore({
    config: { endpoint: "unused", database: "unused" },
    dimensions: 0,
    pool: db.pool,
  });
  await store.init();
});
afterEach(async () => { await db?.drop(); });

const l0 = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  sessionKey: "sk-1",
  sessionId: "sid-1",
  teamId: "t1",
  userId: "u1",
  agentId: "a1",
  role: "user",
  messageText: "hello world",
  recordedAt: new Date().toISOString(),
  timestamp: Date.now(),
  ...over,
});

describe("L0 roundtrip", () => {
  it("writes, counts and reads back by session", async () => {
    expect(await store.upsertL0(l0())).toBe(true);
    expect(await store.upsertL0(l0({ id: "m2", messageText: "second" }))).toBe(true);

    expect(await store.countL0({ teamId: "t1" })).toBe(2);

    const rows = await store.queryL0ForL1("sk-1");
    expect(rows).toHaveLength(2);
    expect(rows[0].message_text).toBe("hello world");
    expect(rows[0].team_id).toBe("t1");
  });

  it("upsert on the same id replaces rather than duplicates", async () => {
    await store.upsertL0(l0());
    await store.upsertL0(l0({ messageText: "edited" }));

    expect(await store.countL0()).toBe(1);
    const rows = await store.queryL0ForL1("sk-1");
    expect(rows[0].message_text).toBe("edited");
  });

  it("queryL0ForL1 honours the afterRecordedAtMs cursor and limit", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-01T01:00:00.000Z");
    await store.upsertL0(l0({ id: "old",   recordedAt: t0.toISOString(), timestamp: t0.getTime() }));
    await store.upsertL0(l0({ id: "fresh", recordedAt: t1.toISOString(), timestamp: t1.getTime() }));

    const after = await store.queryL0ForL1("sk-1", t0.getTime() + 1);
    expect(after.map((r) => r.record_id)).toEqual(["fresh"]);

    expect(await store.queryL0ForL1("sk-1", undefined, 1)).toHaveLength(1);
  });

  it("deleteL0 and deleteL0Expired remove rows", async () => {
    const old = new Date("2026-01-01T00:00:00.000Z").toISOString();
    await store.upsertL0(l0({ id: "a" }));
    await store.upsertL0(l0({ id: "b", recordedAt: old }));

    expect(await store.deleteL0("a")).toBe(true);
    expect(await store.countL0()).toBe(1);

    expect(await store.deleteL0Expired(new Date("2026-06-01T00:00:00.000Z").toISOString())).toBe(1);
    expect(await store.countL0()).toBe(0);
  });

  it("does not leak across tenants", async () => {
    await store.upsertL0(l0({ id: "mine", teamId: "t1" }));
    await store.upsertL0(l0({ id: "theirs", teamId: "t2" }));

    expect(await store.countL0({ teamId: "t1" })).toBe(1);
    expect(await store.countL0({ teamId: "t2" })).toBe(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.l0.test.ts`
Expected: FAIL — `store.upsertL0 is not a function`.

- [ ] **Step 7: Add the L0 methods to `PostgresMemoryStore`**

Add these imports at the top of `memory-store.ts`:

```ts
import type { L0Record, L0QueryRow, L0CountFilter } from "../types.js";
import type { IsolationFilter } from "../isolation.js";
import { buildIsolationWhere } from "./isolation-sql.js";
```

Add these methods to the class:

```ts
  async upsertL0(record: L0Record, _embedding?: Float32Array): Promise<boolean> {
    await this.pool.query(
      `INSERT INTO l0_conversations
         (record_id, session_key, session_id, team_id, user_id, agent_id, task_id,
          role, message_text, recorded_at, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (record_id) DO UPDATE SET
         session_key  = EXCLUDED.session_key,
         session_id   = EXCLUDED.session_id,
         team_id      = EXCLUDED.team_id,
         user_id      = EXCLUDED.user_id,
         agent_id     = EXCLUDED.agent_id,
         task_id      = EXCLUDED.task_id,
         role         = EXCLUDED.role,
         message_text = EXCLUDED.message_text,
         recorded_at  = EXCLUDED.recorded_at,
         timestamp    = EXCLUDED.timestamp`,
      [
        record.id, record.sessionKey, record.sessionId,
        record.teamId ?? "", record.userId ?? "", record.agentId ?? "", record.taskId ?? "",
        record.role, record.messageText, record.recordedAt, record.timestamp,
      ],
    );
    return true;
  }

  async countL0(filter?: L0CountFilter): Promise<number> {
    // L0CountFilter carries the isolation dimensions plus an epoch-ms window;
    // the window has no equivalent in IsolationFilter, so handle it separately.
    const extra: string[] = [];
    const extraParams: unknown[] = [];
    let n = 1;

    if (filter?.timeStartMs !== undefined) { extra.push(` AND timestamp >= $${n++}`); extraParams.push(filter.timeStartMs); }
    if (filter?.timeEndMs   !== undefined) { extra.push(` AND timestamp <= $${n++}`); extraParams.push(filter.timeEndMs); }

    const iso = buildIsolationWhere(filter as IsolationFilter | undefined, n);
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM l0_conversations WHERE TRUE${extra.join("")}${iso.sql}`,
      [...extraParams, ...iso.params],
    );
    return parseInt(rows[0]?.n ?? "0", 10);
  }

  /**
   * Fetch a session's L0 messages for the L1 runner.
   *
   * Keys on `session_key` (not session_id) and, when given, returns only rows
   * recorded strictly after `afterRecordedAtMs` — the L1 cursor.
   */
  async queryL0ForL1(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit?: number,
  ): Promise<L0QueryRow[]> {
    const params: unknown[] = [sessionKey];
    let where = "session_key = $1";

    if (afterRecordedAtMs !== undefined) {
      // recorded_at is an ISO string column; compare in the same units the
      // caller supplied by converting the epoch-ms bound to ISO.
      params.push(new Date(afterRecordedAtMs).toISOString());
      where += ` AND recorded_at >= $${params.length}`;
    }

    params.push(limit ?? 1000);
    const { rows } = await this.pool.query<L0QueryRow & { timestamp: string }>(
      `SELECT record_id, session_key, session_id, team_id, task_id, user_id, agent_id,
              role, message_text, recorded_at, timestamp
         FROM l0_conversations
        WHERE ${where}
        ORDER BY recorded_at ASC, record_id ASC
        LIMIT $${params.length}`,
      params,
    );
    // pg returns BIGINT as string; the interface wants a number.
    return rows.map((r) => ({ ...r, timestamp: Number(r.timestamp) }));
  }

  async deleteL0(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    const iso = buildIsolationWhere(filter, 2);
    await this.pool.query(
      `DELETE FROM l0_conversations WHERE record_id = $1${iso.sql}`,
      [recordId, ...iso.params],
    );
    return true;
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM l0_conversations WHERE recorded_at < $1`,
      [cutoffIso],
    );
    return rowCount ?? 0;
  }
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.l0.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add MemoryCore/src/core/store/postgres/
git commit -m "feat(postgres): L0 upsert, count and session query with isolation pushdown"
```

---

### Task 6: L1 write, count, query and delete

**Files:**
- Modify: `MemoryCore/src/core/store/postgres/memory-store.ts`
- Test: `MemoryCore/src/core/store/postgres/memory-store.l1.test.ts`

**Interfaces:**
- Consumes: `buildIsolationWhere` (Task 5).
- Produces: on `PostgresMemoryStore`: `upsertL1(record, embedding?)`, `countL1(filter?)`, `queryL1Records(filter?)` returning `L1RecordRow[]`, `deleteL1(recordId, filter?)`, `deleteL1Batch(recordIds, filter?)`, `deleteL1Expired(cutoffIso)`.

This satisfies contract case #3 (`L1 write → count → query → delete roundtrip`).

- [ ] **Step 1: Write the failing test**

Create `MemoryCore/src/core/store/postgres/memory-store.l1.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { PostgresMemoryStore } from "./memory-store.js";

let db: TestSchema;
let store: PostgresMemoryStore;

beforeEach(async () => {
  db = await withTestSchema();
  store = new PostgresMemoryStore({
    config: { endpoint: "unused", database: "unused" },
    dimensions: 0,
    pool: db.pool,
  });
  await store.init();
});
afterEach(async () => { await db?.drop(); });

const iso = (d: Date) => d.toISOString();
const l1 = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  content: "the user prefers dark mode",
  type: "persona",
  priority: 50,
  scene_name: "default",
  source_message_ids: ["m1"],
  metadata: {},
  timestamps: [],
  createdAt: iso(new Date()),
  updatedAt: iso(new Date()),
  version: 1,
  sessionKey: "sk-1",
  sessionId: "sid-1",
  teamId: "t1",
  userId: "u1",
  agentId: "a1",
  ...over,
}) as Parameters<PostgresMemoryStore["upsertL1"]>[0];

describe("L1 roundtrip", () => {
  it("writes, counts, queries and deletes", async () => {
    expect(await store.upsertL1(l1())).toBe(true);
    expect(await store.upsertL1(l1({ id: "r2", type: "episodic" }))).toBe(true);

    expect(await store.countL1()).toBe(2);
    expect(await store.countL1({ type: "persona" })).toBe(1);

    const rows = await store.queryL1Records({ teamId: "t1" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.record_id).sort()).toEqual(["r1", "r2"]);

    expect(await store.deleteL1("r1")).toBe(true);
    expect(await store.countL1()).toBe(1);
  });

  it("deleteL1Batch removes several at once", async () => {
    await store.upsertL1(l1({ id: "a" }));
    await store.upsertL1(l1({ id: "b" }));
    await store.upsertL1(l1({ id: "c" }));

    expect(await store.deleteL1Batch(["a", "b"])).toBe(true);
    expect(await store.countL1()).toBe(1);
  });

  it("deleteL1Expired removes rows older than the cutoff", async () => {
    const old = iso(new Date(Date.now() - 86_400_000));
    await store.upsertL1(l1({ id: "old", updatedAt: old }));
    await store.upsertL1(l1({ id: "fresh" }));

    const removed = await store.deleteL1Expired(iso(new Date(Date.now() - 3_600_000)));
    expect(removed).toBe(1);
    expect(await store.countL1()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.l1.test.ts`
Expected: FAIL — `store.upsertL1 is not a function`.

- [ ] **Step 3: Add the L1 methods**

Add to the imports in `memory-store.ts`:

```ts
import type { L1RecordRow, L1CountFilter, L1QueryFilter } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
```

Add to the class:

```ts
  async upsertL1(record: MemoryRecord, _embedding?: Float32Array): Promise<boolean> {
    await this.pool.query(
      `INSERT INTO l1_records
         (record_id, content, type, priority, scene_name, session_key, session_id,
          team_id, user_id, agent_id, task_id, version,
          timestamp_str, timestamp_start, timestamp_end,
          created_time, updated_time, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (record_id) DO UPDATE SET
         content       = EXCLUDED.content,
         type          = EXCLUDED.type,
         priority      = EXCLUDED.priority,
         scene_name    = EXCLUDED.scene_name,
         session_key   = EXCLUDED.session_key,
         session_id    = EXCLUDED.session_id,
         team_id       = EXCLUDED.team_id,
         user_id       = EXCLUDED.user_id,
         agent_id      = EXCLUDED.agent_id,
         task_id       = EXCLUDED.task_id,
         version       = EXCLUDED.version,
         timestamp_str = EXCLUDED.timestamp_str,
         updated_time  = EXCLUDED.updated_time,
         metadata_json = EXCLUDED.metadata_json`,
      [
        record.id, record.content, record.type, record.priority, record.scene_name,
        record.sessionKey, record.sessionId,
        record.teamId ?? "", record.userId ?? "", record.agentId ?? "", record.taskId ?? "",
        record.version ?? 1,
        record.timestamps?.[0] ?? "", record.timestamps?.[0] ?? "",
        record.timestamps?.[record.timestamps.length - 1] ?? "",
        record.createdAt, record.updatedAt,
        JSON.stringify(record.metadata ?? {}),
      ],
    );
    return true;
  }

  async countL1(filter?: L1CountFilter): Promise<number> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let n = 1;

    if (filter?.type !== undefined)      { clauses.push(` AND type = $${n++}`);              params.push(filter.type); }
    if (filter?.timeStart !== undefined) { clauses.push(` AND updated_time >= $${n++}`);     params.push(filter.timeStart); }
    if (filter?.timeEnd !== undefined)   { clauses.push(` AND updated_time <= $${n++}`);     params.push(filter.timeEnd); }

    const iso = buildIsolationWhere(filter as IsolationFilter | undefined, n);
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM l1_records WHERE TRUE${clauses.join("")}${iso.sql}`,
      [...params, ...iso.params],
    );
    return parseInt(rows[0]?.n ?? "0", 10);
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    const iso = buildIsolationWhere(filter as IsolationFilter | undefined, 1);
    const { rows } = await this.pool.query<L1RecordRow>(
      `SELECT record_id, content, type, priority, scene_name, session_key, session_id,
              team_id, task_id, user_id, agent_id, version,
              timestamp_str, timestamp_start, timestamp_end,
              created_time, updated_time, metadata_json
         FROM l1_records
        WHERE TRUE${iso.sql}
        ORDER BY updated_time DESC`,
      iso.params,
    );
    return rows;
  }

  async deleteL1(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    const iso = buildIsolationWhere(filter, 2);
    await this.pool.query(
      `DELETE FROM l1_records WHERE record_id = $1${iso.sql}`,
      [recordId, ...iso.params],
    );
    return true;
  }

  async deleteL1Batch(recordIds: string[], filter?: IsolationFilter): Promise<boolean> {
    if (recordIds.length === 0) return true;
    const iso = buildIsolationWhere(filter, 2);
    await this.pool.query(
      `DELETE FROM l1_records WHERE record_id = ANY($1::text[])${iso.sql}`,
      [recordIds, ...iso.params],
    );
    return true;
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM l1_records WHERE updated_time < $1`,
      [cutoffIso],
    );
    return rowCount ?? 0;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.l1.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add MemoryCore/src/core/store/postgres/
git commit -m "feat(postgres): L1 upsert, count, query, delete and expiry"
```

---

### Task 7: Entity CRUD — teams, users, agents, tasks, knowledge

**Files:**
- Create: `MemoryCore/src/core/store/postgres/entity-store.ts`
- Modify: `MemoryCore/src/core/store/postgres/schema.ts` (add the five entity tables)
- Modify: `MemoryCore/src/core/store/postgres/memory-store.ts` (delegate the entity methods)
- Test: `MemoryCore/src/core/store/postgres/entity-store.test.ts`

**Interfaces:**
- Consumes: `ensureSchema` (Task 3).
- Produces:
  - `class EntityStore` with `createTeam/getTeam/updateTeam/deleteTeams`, and the same quadruple for `User`, `Agent`, `Task`, plus `createKnowledge/getKnowledge/updateKnowledge/deleteKnowledge/listKnowledge`.
  - `PostgresMemoryStore` forwards each of those method names to an internal `EntityStore` instance.

**The entity types, verbatim from `types.ts:404-512`** — note every field is
already snake_case, each entity has its **own** primary key name, several fields
are string arrays, and `BatchDeleteResult` is not a count:

```ts
type TeamStatus = "active" | "archived";
type UserStatus = "active" | "inactive";
type AgentStatus = "active" | "inactive";
type AgentVisibility = "team" | "restricted";
type TaskSourceType = "manual" | "github" | "tapd" | "other";
type KnowledgeType = "wiki" | "code-graph";

interface TeamEntity {
  team_id: string; name: string; description?: string; owner_user_id: string;
  status: TeamStatus; user_ids?: string[]; agent_ids?: string[]; task_ids?: string[];
  created_at: string; updated_at: string;
}
interface UserEntity {
  user_id: string; name: string; job_description?: string;
  team_ids: string[]; task_ids: string[]; owned_agent_ids: string[]; task_agent_ids?: string[];
  status: UserStatus; created_at: string; updated_at: string;
}
interface AgentEntity {
  agent_id: string; team_id: string; name: string; description?: string; prompt?: string;
  owner_user_id?: string; visibility: AgentVisibility; status: AgentStatus;
  task_ids?: string[]; created_at: string; updated_at: string;
}
interface TaskEntity {
  task_id: string; team_id: string; creator_user_id: string; title?: string; description?: string;
  source_type: TaskSourceType; source_url?: string;
  agent_ids: string[]; user_ids: string[]; created_at: string; updated_at: string;
}
interface KnowledgeEntity {
  knowledge_id: string; type: KnowledgeType; service_url: string; name: string;
  summary: string | null; team_id: string; agent_id?: string; user_id: string | null;
  repo_url?: string; branch?: string; created_at: string; updated_at: string;
}
interface KnowledgeListResult { items: KnowledgeEntity[]; total: number }
interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}
```

Because the interface field names are already snake_case and match the column
names one-for-one, rows come back from `pg` in the right shape with no mapper —
except `created_at` / `updated_at`, which the interfaces type as `string`, so
those columns are `TEXT` holding ISO strings rather than `TIMESTAMPTZ`.

- [ ] **Step 1: Add the entity tables to `schema.ts`**

Append inside the same `pool.query` template in `ensureSchema`:

```sql
    CREATE TABLE IF NOT EXISTS entity_teams (
      team_id       TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      owner_user_id TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'active',
      user_ids      TEXT[] NOT NULL DEFAULT '{}',
      agent_ids     TEXT[] NOT NULL DEFAULT '{}',
      task_ids      TEXT[] NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_users (
      user_id         TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      job_description TEXT,
      team_ids        TEXT[] NOT NULL DEFAULT '{}',
      task_ids        TEXT[] NOT NULL DEFAULT '{}',
      owned_agent_ids TEXT[] NOT NULL DEFAULT '{}',
      task_agent_ids  TEXT[] NOT NULL DEFAULT '{}',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_agents (
      agent_id      TEXT PRIMARY KEY,
      team_id       TEXT NOT NULL DEFAULT '',
      name          TEXT NOT NULL,
      description   TEXT,
      prompt        TEXT,
      owner_user_id TEXT,
      visibility    TEXT NOT NULL DEFAULT 'team',
      status        TEXT NOT NULL DEFAULT 'active',
      task_ids      TEXT[] NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_tasks (
      task_id         TEXT PRIMARY KEY,
      team_id         TEXT NOT NULL DEFAULT '',
      creator_user_id TEXT NOT NULL DEFAULT '',
      title           TEXT,
      description     TEXT,
      source_type     TEXT NOT NULL DEFAULT 'manual',
      source_url      TEXT,
      agent_ids       TEXT[] NOT NULL DEFAULT '{}',
      user_ids        TEXT[] NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      knowledge_id TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      service_url  TEXT NOT NULL DEFAULT '',
      name         TEXT NOT NULL,
      summary      TEXT,
      team_id      TEXT NOT NULL DEFAULT '',
      agent_id     TEXT NOT NULL DEFAULT '',
      user_id      TEXT,
      repo_url     TEXT,
      branch       TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_team    ON entity_agents (team_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_team     ON entity_tasks  (team_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_team ON knowledge     (team_id);
```

`user_ids` / `agent_ids` / `task_ids` are `TEXT[]`, which the `pg` driver maps
to and from JavaScript `string[]` with no conversion — matching the interfaces
directly. `summary` and `user_id` are nullable because `KnowledgeEntity` types
them as `string | null`.

- [ ] **Step 2: Write the failing test**

Create `MemoryCore/src/core/store/postgres/entity-store.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { probeCapabilities } from "./client-pool.js";
import { ensureSchema } from "./schema.js";
import { EntityStore } from "./entity-store.js";

let db: TestSchema;
let entities: EntityStore;
const iso = () => new Date().toISOString();

beforeEach(async () => {
  db = await withTestSchema();
  const probe = await probeCapabilities(db.pool);
  await ensureSchema(db.pool, { dimensions: 0, probe });
  entities = new EntityStore(db.pool);
});
afterEach(async () => { await db?.drop(); });

describe("EntityStore", () => {
  it("creates, reads, updates and deletes a team", async () => {
    await entities.createTeam({
      team_id: "t1", name: "Platform", owner_user_id: "u1", status: "active",
      created_at: iso(), updated_at: iso(),
    });

    const team = await entities.getTeam("t1");
    expect(team?.name).toBe("Platform");
    expect(team?.user_ids).toEqual([]); // TEXT[] default round-trips as []

    await entities.updateTeam("t1", { name: "Infra", user_ids: ["u1", "u2"] });
    const updated = await entities.getTeam("t1");
    expect(updated?.name).toBe("Infra");
    expect(updated?.user_ids).toEqual(["u1", "u2"]);

    const result = await entities.deleteTeams(["t1", "missing"]);
    expect(result.deleted_ids).toEqual(["t1"]);
    expect(result.failed).toEqual([{ id: "missing", reason: "not found" }]);
    expect(await entities.getTeam("t1")).toBeNull();
  });

  it("stores agent array fields and enum-ish columns", async () => {
    await entities.createAgent({
      agent_id: "a1", team_id: "t1", name: "Helper",
      visibility: "restricted", status: "active",
      task_ids: ["k1", "k2"], created_at: iso(), updated_at: iso(),
    });

    const agent = await entities.getAgent("a1");
    expect(agent?.visibility).toBe("restricted");
    expect(agent?.task_ids).toEqual(["k1", "k2"]);
  });

  it("lists knowledge scoped to a team with a total", async () => {
    await entities.createKnowledge({
      knowledge_id: "k1", type: "wiki", service_url: "http://x", name: "A",
      summary: null, team_id: "t1", user_id: null, created_at: iso(), updated_at: iso(),
    });
    await entities.createKnowledge({
      knowledge_id: "k2", type: "wiki", service_url: "http://y", name: "B",
      summary: null, team_id: "t2", user_id: null, created_at: iso(), updated_at: iso(),
    });

    const listed = await entities.listKnowledge({ team_id: "t1" });
    expect(listed.total).toBe(1);
    expect(listed.items[0].knowledge_id).toBe("k1");
    expect(listed.items[0].summary).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/entity-store.test.ts`
Expected: FAIL — cannot resolve `./entity-store.js`.

- [ ] **Step 4: Implement `entity-store.ts`**

One generic helper set plus five thin wrappers, so the five entity kinds do not
each get a hand-written copy of the same four statements. Because the interface
fields are already snake_case and match the columns, no field mapper is needed —
insert whatever keys the caller passed.

```ts
import type { Pool } from "pg";
import type {
  TeamEntity, UserEntity, AgentEntity, TaskEntity,
  KnowledgeEntity, KnowledgeListResult, BatchDeleteResult,
} from "../types.js";

/** Table name and primary-key column per entity kind. */
const TABLES = {
  team:      { table: "entity_teams",  pk: "team_id" },
  user:      { table: "entity_users",  pk: "user_id" },
  agent:     { table: "entity_agents", pk: "agent_id" },
  task:      { table: "entity_tasks",  pk: "task_id" },
  knowledge: { table: "knowledge",     pk: "knowledge_id" },
} as const;

type Kind = keyof typeof TABLES;

export class EntityStore {
  constructor(private readonly pool: Pool) {}

  /** Insert every defined key of `entity` as a column of the same name. */
  private async insert(kind: Kind, entity: Record<string, unknown>): Promise<void> {
    const { table, pk } = TABLES[kind];
    const entries = Object.entries(entity).filter(([, v]) => v !== undefined);
    const cols = entries.map(([k]) => k);
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(",");
    await this.pool.query(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})
       ON CONFLICT (${pk}) DO NOTHING`,
      entries.map(([, v]) => v),
    );
  }

  private async getById<T>(kind: Kind, id: string): Promise<T | null> {
    const { table, pk } = TABLES[kind];
    const { rows } = await this.pool.query(`SELECT * FROM ${table} WHERE ${pk} = $1`, [id]);
    return (rows[0] as T | undefined) ?? null;
  }

  private async patch(kind: Kind, id: string, fields: Record<string, unknown>): Promise<void> {
    const { table, pk } = TABLES[kind];
    const entries = Object.entries(fields).filter(([k, v]) => v !== undefined && k !== pk);
    if (entries.length === 0) return;
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    await this.pool.query(
      `UPDATE ${table} SET ${sets}, updated_at = $${entries.length + 2} WHERE ${pk} = $1`,
      [id, ...entries.map(([, v]) => v), new Date().toISOString()],
    );
  }

  /**
   * Delete many by id. Reports which ids actually existed, because
   * BatchDeleteResult distinguishes deleted from failed rather than
   * returning a bare count.
   */
  private async removeMany(kind: Kind, ids: string[]): Promise<BatchDeleteResult> {
    const { table, pk } = TABLES[kind];
    if (ids.length === 0) return { deleted_ids: [], failed: [] };

    const { rows } = await this.pool.query<Record<string, string>>(
      `DELETE FROM ${table} WHERE ${pk} = ANY($1::text[]) RETURNING ${pk}`,
      [ids],
    );
    const deleted_ids = rows.map((r) => r[pk] as string);
    const deletedSet = new Set(deleted_ids);
    const failed = ids
      .filter((id) => !deletedSet.has(id))
      .map((id) => ({ id, reason: "not found" }));
    return { deleted_ids, failed };
  }

  // ── Teams ──
  createTeam(e: TeamEntity) { return this.insert("team", e as unknown as Record<string, unknown>); }
  getTeam(id: string) { return this.getById<TeamEntity>("team", id); }
  updateTeam(id: string, patch: Partial<TeamEntity>) { return this.patch("team", id, patch as Record<string, unknown>); }
  deleteTeams(ids: string[]) { return this.removeMany("team", ids); }

  // ── Users ──
  createUser(e: UserEntity) { return this.insert("user", e as unknown as Record<string, unknown>); }
  getUser(id: string) { return this.getById<UserEntity>("user", id); }
  updateUser(id: string, patch: Partial<UserEntity>) { return this.patch("user", id, patch as Record<string, unknown>); }
  deleteUsers(ids: string[]) { return this.removeMany("user", ids); }

  // ── Agents ──
  createAgent(e: AgentEntity) { return this.insert("agent", e as unknown as Record<string, unknown>); }
  getAgent(id: string) { return this.getById<AgentEntity>("agent", id); }
  updateAgent(id: string, patch: Partial<AgentEntity>) { return this.patch("agent", id, patch as Record<string, unknown>); }
  deleteAgents(ids: string[]) { return this.removeMany("agent", ids); }

  // ── Tasks ──
  createTask(e: TaskEntity) { return this.insert("task", e as unknown as Record<string, unknown>); }
  getTask(id: string) { return this.getById<TaskEntity>("task", id); }
  updateTask(id: string, patch: Partial<TaskEntity>) { return this.patch("task", id, patch as Record<string, unknown>); }
  deleteTasks(ids: string[]) { return this.removeMany("task", ids); }

  // ── Knowledge ──
  createKnowledge(e: KnowledgeEntity) { return this.insert("knowledge", e as unknown as Record<string, unknown>); }
  getKnowledge(id: string) { return this.getById<KnowledgeEntity>("knowledge", id); }
  updateKnowledge(id: string, patch: Partial<KnowledgeEntity>) { return this.patch("knowledge", id, patch as Record<string, unknown>); }
  deleteKnowledge(ids: string[]) { return this.removeMany("knowledge", ids); }

  async listKnowledge(
    filter: { team_id?: string; user_id?: string; limit?: number; offset?: number },
  ): Promise<KnowledgeListResult> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.team_id !== undefined) { params.push(filter.team_id); where.push(`team_id = $${params.length}`); }
    if (filter.user_id !== undefined) { params.push(filter.user_id); where.push(`user_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalRes = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM knowledge ${whereSql}`, params,
    );

    params.push(filter.limit ?? 100, filter.offset ?? 0);
    const { rows } = await this.pool.query<KnowledgeEntity>(
      `SELECT * FROM knowledge ${whereSql}
        ORDER BY updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total: parseInt(totalRes.rows[0]?.n ?? "0", 10) };
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/entity-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Delegate from `PostgresMemoryStore`**

In `memory-store.ts`, add a private field and forwarders:

Import `EntityStore` from `./entity-store.js`, add the field, and write out all
twenty-one forwarders — the class must satisfy `IMemoryStore`, which names each
of them individually:

```ts
  private readonly entities = new EntityStore(this.pool);

  // ── Teams ──
  createTeam  = (...a: Parameters<EntityStore["createTeam"]>)  => this.entities.createTeam(...a);
  getTeam     = (...a: Parameters<EntityStore["getTeam"]>)     => this.entities.getTeam(...a);
  updateTeam  = (...a: Parameters<EntityStore["updateTeam"]>)  => this.entities.updateTeam(...a);
  deleteTeams = (...a: Parameters<EntityStore["deleteTeams"]>) => this.entities.deleteTeams(...a);

  // ── Users ──
  createUser  = (...a: Parameters<EntityStore["createUser"]>)  => this.entities.createUser(...a);
  getUser     = (...a: Parameters<EntityStore["getUser"]>)     => this.entities.getUser(...a);
  updateUser  = (...a: Parameters<EntityStore["updateUser"]>)  => this.entities.updateUser(...a);
  deleteUsers = (...a: Parameters<EntityStore["deleteUsers"]>) => this.entities.deleteUsers(...a);

  // ── Agents ──
  createAgent  = (...a: Parameters<EntityStore["createAgent"]>)  => this.entities.createAgent(...a);
  getAgent     = (...a: Parameters<EntityStore["getAgent"]>)     => this.entities.getAgent(...a);
  updateAgent  = (...a: Parameters<EntityStore["updateAgent"]>)  => this.entities.updateAgent(...a);
  deleteAgents = (...a: Parameters<EntityStore["deleteAgents"]>) => this.entities.deleteAgents(...a);

  // ── Tasks ──
  createTask  = (...a: Parameters<EntityStore["createTask"]>)  => this.entities.createTask(...a);
  getTask     = (...a: Parameters<EntityStore["getTask"]>)     => this.entities.getTask(...a);
  updateTask  = (...a: Parameters<EntityStore["updateTask"]>)  => this.entities.updateTask(...a);
  deleteTasks = (...a: Parameters<EntityStore["deleteTasks"]>) => this.entities.deleteTasks(...a);

  // ── Knowledge ──
  createKnowledge = (...a: Parameters<EntityStore["createKnowledge"]>) => this.entities.createKnowledge(...a);
  getKnowledge    = (...a: Parameters<EntityStore["getKnowledge"]>)    => this.entities.getKnowledge(...a);
  updateKnowledge = (...a: Parameters<EntityStore["updateKnowledge"]>) => this.entities.updateKnowledge(...a);
  deleteKnowledge = (...a: Parameters<EntityStore["deleteKnowledge"]>) => this.entities.deleteKnowledge(...a);
  listKnowledge   = (...a: Parameters<EntityStore["listKnowledge"]>)   => this.entities.listKnowledge(...a);
```

These are class *fields*, so they must be declared after `pool` is assigned in
the constructor — put the `entities` field declaration below the constructor, or
initialise it inside the constructor body if TypeScript complains about
field-ordering.

- [ ] **Step 7: Run the whole postgres suite**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/`
Expected: all tests so far PASS.

- [ ] **Step 8: Commit**

```bash
git add MemoryCore/src/core/store/postgres/
git commit -m "feat(postgres): entity CRUD for teams, users, agents, tasks, knowledge"
```

---

### Task 8: Audit log — `appendAudit` and `queryAudit`

**Files:**
- Modify: `MemoryCore/src/core/store/postgres/schema.ts`
- Modify: `MemoryCore/src/core/store/postgres/memory-store.ts`
- Test: `MemoryCore/src/core/store/postgres/memory-store.audit.test.ts`

**Interfaces:**
- Produces: on `PostgresMemoryStore`: `appendAudit(entry)`, `queryAudit(filter)` — filter supports `teamId`, `agentId`, `since_ms`, `until_ms`, `limit` (default 100, max 1000), `offset`, per the audit filter type near `types.ts:585`.

**The audit types, verbatim from `types.ts:539-588`** — snake_case throughout,
and note there is no free-form `detail` field:

```ts
interface AuditEntry {
  audit_id: string;               // "audit-{uuid}"
  record_id: string;              // L1 → MemoryRecord.id; L2 → file path; L3 → "core"
  layer: "L1" | "L2" | "L3";      // L0 is an immutable stream — never audited
  action: "update" | "delete";
  team_id?: string; agent_id?: string; user_id?: string; task_id?: string;
  version: number;                // the record's new version; delete uses 0 or prev+1
  updated_at_ms: number;
  request_id?: string;            // gateway request id, for tracing
}

interface AuditQueryFilter {
  record_id?: string;
  layer?: "L1" | "L2" | "L3";
  action?: "update" | "delete";
  team_id?: string; agent_id?: string; user_id?: string; task_id?: string;
  since_ms?: number;              // updated_at_ms >= since_ms
  until_ms?: number;              // updated_at_ms <= until_ms
  limit?: number;                 // default 100, hard cap 1000
  offset?: number;
}
```

- [ ] **Step 1: Add the audit table to `ensureSchema`**

```sql
    CREATE TABLE IF NOT EXISTS memory_audit (
      audit_id      TEXT PRIMARY KEY,
      record_id     TEXT NOT NULL,
      layer         TEXT NOT NULL,
      action        TEXT NOT NULL,
      team_id       TEXT NOT NULL DEFAULT '',
      agent_id      TEXT NOT NULL DEFAULT '',
      user_id       TEXT NOT NULL DEFAULT '',
      task_id       TEXT NOT NULL DEFAULT '',
      version       INTEGER NOT NULL DEFAULT 0,
      updated_at_ms BIGINT NOT NULL,
      request_id    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_team_at   ON memory_audit (team_id, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_record    ON memory_audit (record_id, updated_at_ms DESC);
```

- [ ] **Step 2: Write the failing test**

Create `MemoryCore/src/core/store/postgres/memory-store.audit.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { PostgresMemoryStore } from "./memory-store.js";

let db: TestSchema;
let store: PostgresMemoryStore;

beforeEach(async () => {
  db = await withTestSchema();
  store = new PostgresMemoryStore({
    config: { endpoint: "unused", database: "unused" },
    dimensions: 0,
    pool: db.pool,
  });
  await store.init();
});
afterEach(async () => { await db?.drop(); });

const entry = (over: Record<string, unknown> = {}) => ({
  audit_id: `audit-${Math.random().toString(36).slice(2)}`,
  record_id: "r1",
  layer: "L1" as const,
  action: "update" as const,
  team_id: "t1",
  agent_id: "a1",
  version: 1,
  updated_at_ms: Date.now(),
  ...over,
});

describe("audit log", () => {
  it("appends entries and queries them newest-first within a window", async () => {
    const base = Date.now();
    await store.appendAudit(entry({ updated_at_ms: base }));
    await store.appendAudit(entry({ action: "delete", version: 2, updated_at_ms: base + 10 }));
    await store.appendAudit(entry({ team_id: "t2", agent_id: "a2", updated_at_ms: base + 20 }));

    const mine = await store.queryAudit({ team_id: "t1" });
    expect(mine).toHaveLength(2);
    expect(mine[0].action).toBe("delete");      // newest first
    expect(mine[0].updated_at_ms).toBe(base + 10);
    expect(typeof mine[0].updated_at_ms).toBe("number"); // BIGINT must not leak as string

    const windowed = await store.queryAudit({ team_id: "t1", since_ms: base + 5 });
    expect(windowed).toHaveLength(1);
  });

  it("filters by layer and action", async () => {
    await store.appendAudit(entry({ layer: "L2", action: "delete" }));
    await store.appendAudit(entry({ layer: "L1", action: "update" }));

    expect(await store.queryAudit({ layer: "L2" })).toHaveLength(1);
    expect(await store.queryAudit({ action: "delete" })).toHaveLength(1);
  });

  it("defaults limit to 100 and caps it at 1000", async () => {
    const base = Date.now();
    for (let i = 0; i < 105; i++) {
      await store.appendAudit(entry({ record_id: `r${i}`, updated_at_ms: base + i }));
    }
    expect(await store.queryAudit({ team_id: "t1" })).toHaveLength(100);
    // 5000 is clamped to 1000, which is still above the 105 rows present.
    expect(await store.queryAudit({ team_id: "t1", limit: 5000 })).toHaveLength(105);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.audit.test.ts`
Expected: FAIL — `store.appendAudit is not a function`.

- [ ] **Step 4: Implement the two methods**

Add `AuditEntry` and `AuditQueryFilter` to the type imports in `memory-store.ts`, then:

```ts
  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_audit
         (audit_id, record_id, layer, action, team_id, agent_id, user_id, task_id,
          version, updated_at_ms, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (audit_id) DO NOTHING`,
      [
        entry.audit_id, entry.record_id, entry.layer, entry.action,
        entry.team_id ?? "", entry.agent_id ?? "", entry.user_id ?? "", entry.task_id ?? "",
        entry.version, entry.updated_at_ms, entry.request_id ?? null,
      ],
    );
  }

  async queryAudit(filter: AuditQueryFilter = {}): Promise<AuditEntry[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (col: string, v: unknown) => { params.push(v); where.push(`${col} = $${params.length}`); };

    if (filter.record_id !== undefined) eq("record_id", filter.record_id);
    if (filter.layer     !== undefined) eq("layer",     filter.layer);
    if (filter.action    !== undefined) eq("action",    filter.action);
    if (filter.team_id   !== undefined) eq("team_id",   filter.team_id);
    if (filter.agent_id  !== undefined) eq("agent_id",  filter.agent_id);
    if (filter.user_id   !== undefined) eq("user_id",   filter.user_id);
    if (filter.task_id   !== undefined) eq("task_id",   filter.task_id);
    if (filter.since_ms  !== undefined) { params.push(filter.since_ms); where.push(`updated_at_ms >= $${params.length}`); }
    if (filter.until_ms  !== undefined) { params.push(filter.until_ms); where.push(`updated_at_ms <= $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(Math.min(filter.limit ?? 100, 1000), filter.offset ?? 0);

    const { rows } = await this.pool.query<AuditEntry & { updated_at_ms: string }>(
      `SELECT * FROM memory_audit ${whereSql}
        ORDER BY updated_at_ms DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    // pg returns BIGINT as a string; the interface types it as number.
    return rows.map((r) => ({ ...r, updated_at_ms: Number(r.updated_at_ms) }));
  }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.audit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add MemoryCore/src/core/store/postgres/
git commit -m "feat(postgres): audit append and windowed query"
```

---

### Task 9: `clearMemoryContent` + isolation count-pushdown verification

**Files:**
- Modify: `MemoryCore/src/core/store/postgres/memory-store.ts`
- Test: `MemoryCore/src/core/store/postgres/memory-store.clear.test.ts`

**Interfaces:**
- Consumes: L0/L1 methods (Tasks 5, 6).
- Produces: `clearMemoryContent(filter: MemoryContentClearFilter): Promise<MemoryContentClearResult>` — deletes L0, L1 and profile rows for one scope; idempotent; throws when `teamId` or `agentId` is absent.

This satisfies contract cases #9 and #10, and covers the count-pushdown half of #6.

**The clear types, verbatim from `types.ts:477-493`** — these two are camelCase,
unlike the entity and audit types:

```ts
interface MemoryContentClearFilter {
  teamId: string;    // required — refusing without it is the guard against wiping the DB
  agentId: string;   // required
  userId?: string;   // optional: narrow to one user; absent means all users under the agent
}

interface MemoryContentClearResult {
  l0Deleted: number;
  l1Deleted: number;
  profilesDeleted: number;   // L2/L3 profile rows
}
```

Per the interface docs: without `sessionId` the clear covers every session under
that `(team, agent)`; it removes content rows only (L0/L1 plus their vector/FTS
attachments) and never touches the `meta_*` asset tables.

- [ ] **Step 1: Write the failing test**

Create `MemoryCore/src/core/store/postgres/memory-store.clear.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { withTestSchema, type TestSchema } from "./__tests__/test-db.js";
import { PostgresMemoryStore } from "./memory-store.js";

let db: TestSchema;
let store: PostgresMemoryStore;

beforeEach(async () => {
  db = await withTestSchema();
  store = new PostgresMemoryStore({
    config: { endpoint: "unused", database: "unused" },
    dimensions: 0,
    pool: db.pool,
  });
  await store.init();
});
afterEach(async () => { await db?.drop(); });

const seed = async (teamId: string, agentId: string, id: string) => {
  await store.upsertL0({
    id: `l0-${id}`, sessionKey: "sk", sessionId: "sid",
    teamId, userId: "u1", agentId,
    role: "user", messageText: "hi", recordedAt: new Date().toISOString(), timestamp: Date.now(),
  });
};

describe("clearMemoryContent", () => {
  it("clears one scope, leaves others, and is idempotent", async () => {
    await seed("t1", "a1", "1");
    await seed("t2", "a2", "2");

    const first = await store.clearMemoryContent({ teamId: "t1", agentId: "a1" });
    expect(first.l0Deleted).toBeGreaterThan(0);

    expect(await store.countL0({ teamId: "t1" })).toBe(0);
    expect(await store.countL0({ teamId: "t2" })).toBe(1);

    // Idempotent: a second clear succeeds and removes nothing more.
    const second = await store.clearMemoryContent({ teamId: "t1", agentId: "a1" });
    expect(second.l0Deleted).toBe(0);
  });

  it("narrows to one user when userId is given", async () => {
    await store.upsertL0({
      id: "u1-msg", sessionKey: "sk", sessionId: "sid",
      teamId: "t1", userId: "u1", agentId: "a1",
      role: "user", messageText: "hi", recordedAt: new Date().toISOString(), timestamp: Date.now(),
    });
    await store.upsertL0({
      id: "u2-msg", sessionKey: "sk", sessionId: "sid",
      teamId: "t1", userId: "u2", agentId: "a1",
      role: "user", messageText: "hi", recordedAt: new Date().toISOString(), timestamp: Date.now(),
    });

    const res = await store.clearMemoryContent({ teamId: "t1", agentId: "a1", userId: "u1" });
    expect(res.l0Deleted).toBe(1);
    expect(await store.countL0({ userId: "u2" })).toBe(1);
  });

  it("rejects a filter missing team or agent", async () => {
    await expect(store.clearMemoryContent({ agentId: "a1" } as never)).rejects.toThrow(/teamId/);
    await expect(store.clearMemoryContent({ teamId: "t1" } as never)).rejects.toThrow(/agentId/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.clear.test.ts`
Expected: FAIL — `store.clearMemoryContent is not a function`.

- [ ] **Step 3: Implement it**

Add `MemoryContentClearFilter` and `MemoryContentClearResult` to the type imports
in `memory-store.ts`, then:

```ts
  async clearMemoryContent(filter: MemoryContentClearFilter): Promise<MemoryContentClearResult> {
    // Refusing an under-specified scope is the guard against wiping the database.
    if (!filter?.teamId)  throw new Error(`${TAG} clearMemoryContent requires teamId`);
    if (!filter?.agentId) throw new Error(`${TAG} clearMemoryContent requires agentId`);

    const params: unknown[] = [filter.teamId, filter.agentId];
    let scopeSql = "team_id = $1 AND agent_id = $2";
    if (filter.userId !== undefined) {
      params.push(filter.userId);
      scopeSql += ` AND user_id = $${params.length}`;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const l0 = await client.query(`DELETE FROM l0_conversations WHERE ${scopeSql}`, params);
      const l1 = await client.query(`DELETE FROM l1_records WHERE ${scopeSql}`, params);

      // The `profiles` table arrives in Phase 3. Use to_regclass rather than a
      // try/catch: a failed statement inside a transaction aborts the whole
      // transaction in Postgres, so catching the error would not save the commit.
      let profilesDeleted = 0;
      const { rows } = await client.query<{ exists: string | null }>(
        "SELECT to_regclass('profiles')::text AS exists",
      );
      if (rows[0]?.exists) {
        const p = await client.query(`DELETE FROM profiles WHERE ${scopeSql}`, params);
        profilesDeleted = p.rowCount ?? 0;
      }

      await client.query("COMMIT");
      return {
        l0Deleted: l0.rowCount ?? 0,
        l1Deleted: l1.rowCount ?? 0,
        profilesDeleted,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/memory-store.clear.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add MemoryCore/src/core/store/postgres/
git commit -m "feat(postgres): transactional clearMemoryContent with strict scope validation"
```

---

### Task 10: Wire into config and factory, and run the shared contract

**Files:**
- Modify: `MemoryCore/src/config.ts:183` and `:499`
- Modify: `MemoryCore/src/utils/manifest.ts:107-115`
- Modify: `MemoryCore/src/core/store/factory.ts`
- Create: `MemoryCore/src/core/store/postgres/__tests__/harness.ts`
- Test: `MemoryCore/src/core/store/postgres/postgres-store.contract.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `storeBackend: "postgres"` is selectable end-to-end; `postgresHarness: MemoryStoreContractHarness` for the shared contract.

- [ ] **Step 1: Extend the backend union**

In `MemoryCore/src/config.ts` line 183:

```ts
export type StoreBackend = "sqlite" | "tcvdb" | "mongodb" | "postgres";
```

And at line ~499:

```ts
  const storeBackend: StoreBackend =
    storeBackendRaw === "tcvdb" ? "tcvdb"
    : storeBackendRaw === "mongodb" ? "mongodb"
    : storeBackendRaw === "postgres" ? "postgres"
    : "sqlite";
```

- [ ] **Step 2: Widen `StoreConfigSnapshot`**

`StoreConfigSnapshot.type` is a closed union, so the factory cannot report a
postgres store without this edit. In `MemoryCore/src/utils/manifest.ts` line 107:

```ts
export interface StoreConfigSnapshot {
  type: "sqlite" | "tcvdb" | "mongodb" | "postgres";
  sqlitePath?: string;
  tcvdbUrl?: string;
  tcvdbDatabase?: string;
  tcvdbAlias?: string;
  mongoEndpoint?: string;
  mongoDatabase?: string;
  pgEndpoint?: string;
  pgDatabase?: string;
}
```

Leave `buildStoreInfo` alone: its `if / else if` chain already falls through to
the bare `{ type: snapshot.type }` it initialises for any type it does not
specifically handle, which is correct for postgres in Phase 1.

`manifest.ts` is a shared utility, not a store backend, so this does not touch
the "never modify `sqlite/`, `tcvdb/`, `mongodb/`" constraint.

- [ ] **Step 3: Add the factory case**

In `MemoryCore/src/core/store/factory.ts`, import the new pieces:

```ts
import { PostgresMemoryStore } from "./postgres/memory-store.js";
import { readPgEnvConfig } from "./postgres/client-pool.js";
```

and add this case before `case "sqlite"`:

```ts
    case "postgres": {
      const pgConfig = readPgEnvConfig(); // throws when PG_ENDPOINT/PG_DATABASE are missing
      let embeddingService: EmbeddingService | undefined;
      if (config.embedding.enabled && config.embedding.provider !== "local" && config.embedding.apiKey) {
        embeddingService = createEmbeddingService({
          provider: config.embedding.provider,
          baseUrl: config.embedding.baseUrl,
          apiKey: config.embedding.apiKey,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
          sendDimensions: config.embedding.sendDimensions,
          maxInputChars: config.embedding.maxInputChars,
        }, logger);
      }

      const store = new PostgresMemoryStore({
        config: pgConfig,
        dimensions: config.embedding.dimensions,
        logger,
      });

      logger?.debug?.(
        `${TAG} Store created: backend=postgres, endpoint=${pgConfig.endpoint}, database=${pgConfig.database}`,
      );

      return {
        // Cast: the store is Partial<IMemoryStore> until Phase 3/4 completes
        // the surface. Phase 1 wires it so the backend is reachable end-to-end.
        store: store as unknown as IMemoryStore,
        embedding: (embeddingService ?? new NoopEmbeddingService()) as unknown as IEmbeddingService,
        bm25Encoder,
        storeSnapshot: {
          type: "postgres",
          pgEndpoint: pgConfig.endpoint,
          pgDatabase: pgConfig.database,
        },
      };
    }
```

The `storeSnapshot` needs no cast once Step 2 has widened the union.

- [ ] **Step 4: Write the contract harness**

Create `MemoryCore/src/core/store/postgres/__tests__/harness.ts`:

```ts
import type { IMemoryStore } from "../../types.js";
import type { MemoryStoreContractHarness } from "../../__contract__/memory-store.contract.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { withTestSchema, type TestSchema } from "./test-db.js";

const live = new Map<IMemoryStore, TestSchema>();

export const postgresHarness: MemoryStoreContractHarness = {
  backend: "postgres",
  // Postgres writes are visible to the next statement — no polling needed.
  ftsEventuallyConsistent: false,

  async createStore(): Promise<IMemoryStore> {
    const db = await withTestSchema();
    const store = new PostgresMemoryStore({
      config: { endpoint: "unused", database: "unused" },
      dimensions: 4,
      pool: db.pool,
    });
    await store.init();
    const asStore = store as unknown as IMemoryStore;
    live.set(asStore, db);
    return asStore;
  },

  async disposeStore(store: IMemoryStore): Promise<void> {
    const db = live.get(store);
    live.delete(store);
    await db?.drop();
  },
};
```

- [ ] **Step 5: Write the contract test file**

Create `MemoryCore/src/core/store/postgres/postgres-store.contract.test.ts`:

```ts
import { runMemoryStoreContract } from "../__contract__/memory-store.contract.js";
import { postgresHarness } from "./__tests__/harness.js";

runMemoryStoreContract(postgresHarness);
```

- [ ] **Step 6: Run the contract and record which cases pass**

Run: `cd MemoryCore && npx vitest run src/core/store/postgres/postgres-store.contract.test.ts`

Expected at the end of Phase 1: cases #1, #2, #3, #9 and #10 PASS. Cases #4, #5, #6 (FTS) and #7, #8 (profiles) FAIL — they belong to Phases 2 and 3. Record the exact failure list in the commit message; do **not** stub them to green.

- [ ] **Step 7: Typecheck and run the full suite**

Run:

```bash
cd MemoryCore
npx tsc --noEmit
npx vitest run src/core/store/postgres/
```

Expected: `tsc` clean; every non-contract postgres test passes.

- [ ] **Step 8: Commit**

```bash
git add MemoryCore/src/config.ts MemoryCore/src/core/store/factory.ts MemoryCore/src/core/store/postgres/
git commit -m "feat(postgres): wire backend into config + factory, run shared contract

Contract status at end of Phase 1: #1 #2 #3 #9 #10 pass;
#4 #5 #6 (FTS) deferred to Phase 2, #7 #8 (profiles) to Phase 3."
```

---

## Phase 1 exit criteria

- `storeBackend = "postgres"` selects the backend through the real factory.
- Contract cases #1, #2, #3, #9, #10 pass against a live Postgres.
- `npx tsc --noEmit` is clean.
- No file under `sqlite/`, `tcvdb/` or `mongodb/` has been modified (`git diff --stat main -- MemoryCore/src/core/store/{sqlite,tcvdb,mongodb}` is empty).

## Follow-up plans

- **Phase 2** — `search.ts`: pgvector vector search, `tsvector` FTS with the `'simple'` config, HNSW indexes. Targets contract #4, #5, #6.
- **Phase 3** — `profile-store.ts`: L2/L3 profile rows, `IProfileRowStore`. Targets contract #7, #8 → 10/10.
- **Phase 4** — `sparsevec` hybrid search with RRF fusion and the application-layer degradation path; PG-specific tests (`EXPLAIN` asserts HNSW usage, jieba-token recall).
