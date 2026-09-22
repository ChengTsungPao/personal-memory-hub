# Postgres store backend — design

**Date:** 2026-09-22
**Status:** approved, ready for implementation planning
**Repo:** `ChengTsungPao/personal-memory-hub`
**Branch:** `feat/postgres-store-backend`

## Goal

Add `"postgres"` as a fourth `storeBackend` to MemoryCore, implementing the full
`IMemoryStore` surface — vector search, full-text search, hybrid search, and
L2/L3 profile rows — on a single PostgreSQL instance with `pgvector`.

This is a **private-use fork**. Upstream contribution is not a goal, so the
design optimises for a backend the owner can maintain, not for matching the
upstream project's internal conventions. Nothing in the existing `sqlite` / `tcvdb` / `mongodb`
backends is modified.

### Why Postgres rather than Milvus

`IMemoryStore` is only half vector work. The other half — `teams`, `users`,
`agents`, `tasks`, `knowledge`, `audit`, `profiles` — is ordinary relational
CRUD with tenant-scoped filters. Milvus has no relational layer, so a Milvus
backend would need a second database beside it and a consistency story between
them. Postgres covers the whole interface in one engine, and `sqlite/` (which is
also one engine doing vectors + FTS + relations) is a close structural template.

## Deployment targets

Local Docker first (`pgvector/pgvector:pg17`), AWS RDS later. Extension
availability therefore cannot be assumed — see *Capability detection*.

## Architecture

New directory `MemoryCore/src/core/store/postgres/`. File layout follows
`mongodb/` (the cleanest existing backend: 2,064 lines across 6 files) rather
than `sqlite/` (4,402 lines across 2 files), so each unit stays small enough to
read in one sitting.

| File | Responsibility | Est. lines |
|---|---|---|
| `client-pool.ts` | Shared `pg.Pool`, connection config from env, extension/version probe | ~250 |
| `schema.ts` | Idempotent DDL: `CREATE EXTENSION`, tables, indexes | ~400 |
| `memory-store.ts` | `IMemoryStore` core: L0/L1 read+write, counts, entity CRUD, audit | ~1,400 |
| `profile-store.ts` | `IProfileRowStore`: L2/L3 profile sync, query, delete | ~400 |
| `search.ts` | Vector / FTS / hybrid query construction, isolation pushdown | ~500 |
| `skill-store.ts` | Skill storage | ~450 |

### Wiring (three small edits, no behaviour change to other backends)

1. `src/config.ts:183` — `export type StoreBackend = "sqlite" | "tcvdb" | "mongodb" | "postgres"`
2. `src/config.ts:499` — parse the `"postgres"` string in `parseConfig`
3. `src/core/store/factory.ts` — add `case "postgres":`, reading `PG_*` env vars,
   mirroring how the `mongodb` case reads `readMongoEnvConfig()`

Connection config comes from the environment (`PG_ENDPOINT`, `PG_DATABASE`,
`PG_USER`, `PG_PASSWORD`, `PG_SSL`), matching the `mongodb` precedent. Missing
required values throw from the factory, not at first query.

Embedding follows the `sqlite` path, not the `tcvdb`/`mongodb` path: pgvector
does not embed text itself, so the client-side `EmbeddingService` produces
vectors and the store receives them as `Float32Array`.

## Schema

| SQLite | Postgres |
|---|---|
| `l1_records` + `l1_vec` (`vec0` virtual table) | `l1_records`, embedding as a `vector(N)` column on the same row |
| `l0_conversations` + `l0_vec` | `l0_conversations`, same |
| FTS5 virtual table | `tsvector` generated column + GIN index |
| `entity_teams` / `entity_users` / `entity_agents` / … | same names; `TEXT`→`TEXT`, `INTEGER`→`BIGINT` |
| *(absent in SQLite)* | `profiles` — modelled on the `PROFILES` collection in `mongodb/collections.ts` |

pgvector stores vectors as an ordinary column, so L0/L1 read and write paths are
**shorter** than SQLite's, which must join its `vec0` virtual table back to the
record table.

Indexes carry over from `sqlite/memory-store.ts` one-for-one (the isolation and
recency composite indexes — `idx_l1_team_agent_updated`, `idx_l0_user_agent_session`,
and the rest), plus HNSW indexes on each embedding column.

## Search

### Three paths

| Path | Implementation | Index |
|---|---|---|
| `searchL*Vector` | `embedding <=> $1::vector` (cosine), `ORDER BY … LIMIT` | HNSW, `vector_cosine_ops` |
| `searchL*Fts` | `to_tsvector('simple', tokens) @@ to_tsquery('simple', …)`, ranked by `ts_rank` | GIN |
| `searchL1Hybrid` | `sparsevec` sparse vector + dense vector, top-K from each, fused with RRF | two HNSW indexes |

### Chinese text needs no extension

The repo pre-segments Chinese with jieba `cutForSearch` and stores
space-joined tokens (design note D6 in `core/store/tokenize.ts`), so every
backend uses a plain whitespace tokenizer and never re-segments.

Postgres therefore uses the **`'simple'`** text search configuration, which
splits on whitespace and punctuation with no stemming and no stop-word list —
exactly matching what D6 already wrote. No `zhparser`, no `pg_bigm`, and nothing
that AWS RDS might refuse to install.

`ts_rank` is not true BM25. The contract test only asserts keyword *recall*, not
a ranking algorithm, so this is acceptable; the BM25 signal enters through the
sparse-vector path instead.

### Capability detection

`client-pool.ts` probes once during `init()`:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

| pgvector | `vectorSearch` | `ftsSearch` | `sparseVectors` | `nativeHybridSearch` |
|---|:---:|:---:|:---:|:---:|
| ≥ 0.7 (`sparsevec` present) | yes | yes | yes | yes |
| 0.5–0.6 | yes | yes | no | degraded |
| not installed | no | yes | no | no |

`profileRows` is unconditionally `true` — profile rows are plain relational
tables and depend on no extension.

### Degradation

When `sparsevec` is unavailable, `searchL1Hybrid` still works: it runs the
vector and FTS paths separately and fuses the two result sets with RRF in the
application layer, losing only the sparse-vector contribution.
`getCapabilities()` reports the truth and callers decide. The same code
therefore runs against local Docker (pgvector 0.8, everything on) and a future
RDS instance of unknown version.

## Error handling

Connection failure and a missing `vector` extension throw from `init()` with a
tagged message, matching the existing tagged-`throw new Error` style in
`factory.ts`. Query-layer errors are not swallowed; the existing `isDegraded()`
mechanism reports persistent unavailability upward.

## Testing

`MemoryCore` ships **no** `.test.ts` files — the open-source release stripped
them — but `core/store/__contract__/memory-store.contract.ts` survives intact
and exports `runMemoryStoreContract(harness)` (10 tests). The harness is written
here; the contract is reused as-is.

```
postgres/__tests__/
├── docker-compose.postgres.yaml   pgvector/pgvector:pg17
├── harness.ts                     implements MemoryStoreContractHarness
└── postgres-store.test.ts         runMemoryStoreContract(harness) + PG-specific cases
```

Tests run with vitest (`MemoryCore/vitest.config.ts` already exists) against a
**real** Postgres. Vector indexes, `tsvector` behaviour and RRF fusion are the
things most likely to be wrong, and all three vanish under mocking. Each test
run gets an isolated schema (`CREATE SCHEMA test_<uuid>`), dropped on teardown.

PG-specific cases beyond the contract:

- extension version probe and each degradation branch
- HNSW index is actually used by the planner (assert on `EXPLAIN` output)
- `'simple'` config recalls jieba-segmented Chinese tokens

## Delivery phases

Each phase ends with a backend that runs — never a half-written one.

| Phase | Scope | Done when |
|---|---|---|
| 1 | `client-pool` + `schema` + L0/L1 read/write/count + isolation filters + entity CRUD + audit | contract #1 #2 #3 #6 #9 #10 pass |
| 2 | `search.ts` — pgvector vector search + tsvector FTS | contract #4 #5 pass |
| 3 | `profile-store.ts` — L2/L3 profile rows | contract #7 #8 pass → 10/10 |
| 4 | `sparsevec` hybrid + degradation paths | all capabilities on, PG-specific cases pass |

Phase 1 alone already stores and retrieves memory; it simply cannot search yet.

## Out of scope

- Modifying the `sqlite`, `tcvdb`, or `mongodb` backends
- A shared SQL-dialect abstraction across `sqlite` and `postgres` (considered and
  rejected: it would put the working SQLite backend at risk for no gain here)
- An upstream pull request
- Data migration from an existing backend into Postgres
