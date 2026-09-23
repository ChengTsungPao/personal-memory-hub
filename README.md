# Personal Memory Hub

**A private, self-hosted long-term memory server for AI coding agents.**

Agents forget everything between sessions. This runs a memory server beside
them so they don't: conversations are distilled into layered, searchable
memory, and every agent you use — across editors, CLIs and machines — reads and
writes the same store.

Self-hosted by design. The data lives in a database you run.

[Installation](#installation) · [What it does](#what-it-does) · [How memory is layered](#how-memory-is-layered) · [Storage backends](#storage-backends) · [Development](#development)

---

## What it does

- **Remembers people and context** — preferences, constraints, decisions and
  the reasons behind them, carried into every later session.
- **Accumulates skills** — reusable procedures learned from completed work,
  not just facts.
- **Indexes docs and code** — documents become searchable pages; repositories
  become a graph of files, symbols and call relationships, queried on demand
  rather than pasted wholesale into context.
- **Shares across agents** — one memory server, many front-ends. Switching
  tools does not mean starting over.
- **Keeps humans in control** — assets are explicitly bound to agents with an
  access-control layer, so a team can share experience without sharing
  everything.

## Installation

See [INSTALL.md](./INSTALL.md) for the full deployment guide (memory core,
hub, and proxy).

## How memory is layered

Raw conversation is cheap to store and expensive to search, so an asynchronous
pipeline refines it into progressively coarser layers:

| Layer | What it stores | Primary use |
| :--- | :--- | :--- |
| **L0 Conversation** | Raw conversations with full context | Verify exact wording, timestamps and sources |
| **L1 Atom** | Facts, preferences, constraints and events extracted from conversations | Precise recall of actionable information |
| **L2 Scenario** | Knowledge blocks organised around a project or scenario | Quickly restore a working context |
| **L3 Core / Persona** | Long-term profiles, stable patterns, high-level cognition | Let an agent enter your context fast |

Retrieval is layered the same way. L2/L3 bootstrap context cheaply; when a
specific fact is needed, BM25 plus vector retrieval with RRF fusion falls back
to L1/L0. Results are capped by item count, character budget and timeout, so
memory never floods the context window.

## Storage backends

The store is an interface (`IMemoryStore`) with interchangeable
implementations, selected by `storeBackend` in config:

| Backend | Engine | Notes |
| :--- | :--- | :--- |
| `sqlite` | SQLite + `sqlite-vec` + FTS5 | Default. Zero setup, single file, local only. |
| `postgres` | PostgreSQL + `pgvector` + `tsvector` | **In development** — see the design notes below. One engine for vectors, full-text and relational data. |
| `mongodb` | MongoDB | Server-side text search. |

The upstream `tcvdb` (Tencent Cloud VectorDB) backend has been removed from
this fork — the Postgres backend below is its replacement: one self-hosted
engine covering the same surface, with no vendor-hosted vector store to run.

Chinese text is pre-segmented with jieba at write time and stored as
space-joined tokens, so every backend can use a plain whitespace tokenizer and
none of them re-segment.

### The Postgres backend

This fork's main line of work: a backend that covers the whole `IMemoryStore`
surface — vector search, full-text search, hybrid search and profile rows — on
a single PostgreSQL instance, so there is no separate vector database to run.

- Design: [`docs/superpowers/specs/2026-09-22-postgres-store-backend-design.md`](./docs/superpowers/specs/2026-09-22-postgres-store-backend-design.md)
- Phase 1 plan: [`docs/superpowers/plans/2026-09-22-postgres-store-backend-phase1.md`](./docs/superpowers/plans/2026-09-22-postgres-store-backend-phase1.md)

## Development

```bash
cd MemoryCore
npm install
npm test
```

Backend tests run against a real database rather than mocks — vector indexes,
full-text behaviour and rank fusion all vanish under mocking. The Postgres
suite brings up `pgvector/pgvector:pg17` via Docker Compose and isolates each
run in its own schema.

## Related documentation

- [Installation guide](./INSTALL.md)
- [Contributing](./CONTRIBUTING.md)
- [Roadmap](./ROADMAP.md)
- API references: [Memory Core v3](./MemoryCore/v3-api-memorycore-doc.md) ·
  [Memory Knowledge v3](./MemoryKnowledge/v3-api-memoryknowledge-doc.md) ·
  [Memory Proxy v3](./MemoryProxy/v3-api-memoryproxy-doc.md) ·
  [Memory Panel](./MemoryPanel/panel-api-doc.md)

## Notes

- Wiki and code-graph assets are built asynchronously; allow processing time
  before they reach `ready`.
- Code indexing prioritises public HTTPS repositories; private repositories and
  SSH credentials are still being refined.
- Asset binding is manual; fully automated memory routing is not done yet.

## Licence

MIT. See [LICENSE](./LICENSE).

---

## Reference

Built on [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
by Tencent (MIT). This repository is independent, maintained separately, and not
affiliated with or endorsed by Tencent. The original copyright notice is
retained in [LICENSE](./LICENSE) as the MIT terms require.

**Forked at** commit
[`5017e2b`](https://github.com/TencentCloud/TencentDB-Agent-Memory/commit/5017e2bb927c65bd8302af2d984b04db46303f1b)
— `fix(memory-core): enforce caller-scoped ACL on asset/get and asset/list (#1464)`,
2026-09-21, from the upstream default branch `feat/server_team`.

History before that point is not carried in this repository; it lives upstream.
To diff against it:

```bash
git remote add upstream https://github.com/TencentCloud/TencentDB-Agent-Memory.git
git fetch upstream
git diff 5017e2b HEAD
```
