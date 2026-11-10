#!/usr/bin/env node
/**
 * Rebuild L2 scene blocks and L3 persona for session blocks from their full L1 history.
 *
 * Usage (stop memory-core first: it writes the same profiles, and holds vectors.db in WAL mode):
 *   cd MemoryCore && TDAI_LLM_ASYNC_JOBS=true node --import tsx scripts/rebuild-l2-l3.ts <core-data dir> <tdai-gateway.yaml>
 *
 * Env:
 *   ONLY=agt-a,agt-b   rebuild only these blocks
 *   SKIP=agt-c         leave these blocks untouched (e.g. a repo block whose L2 came from elsewhere)
 *   BATCH=25           L1 records per scene-extraction call
 *   DRY=1              print the per-block plan and exit
 *
 * L1 comes from records/*.jsonl, not the l1_records table (see core/record/l1-log.ts). A block is a
 * target when it owns at least one live L1 record; its scene_blocks, persona and checkpoint are
 * wiped and re-extracted. Blocks are processed smallest first.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StandaloneLLMRunnerFactory } from "../src/adapters/standalone/llm-runner.js";
import { PersonaGenerator } from "../src/core/persona/persona-generator.js";
import { assignL1Records, parseL1Log, type L1Row } from "../src/core/record/l1-log.js";
import { SceneExtractor } from "../src/core/scene/scene-extractor.js";

const [coreData, yamlPath] = process.argv.slice(2);
if (!coreData || !yamlPath) {
  console.error("usage: rebuild-l2-l3.ts <core-data dir> <tdai-gateway.yaml>");
  process.exit(1);
}
const list = (v?: string) => new Set((v ?? "").split(",").filter(Boolean));
const only = list(process.env.ONLY);
const skip = list(process.env.SKIP);
const BATCH = Number(process.env.BATCH) || 25;
// Production runs these as async gateway jobs with a 30-minute limit; the classes default to 3–5 minutes.
const TIMEOUT_MS = 1_800_000;

const log = (m: string) => console.log(`${new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19)} ${m}`);
const logger = { info: log, warn: (m: string) => log(`WARN ${m}`), error: (m: string) => log(`ERROR ${m}`), debug: () => {} };

const yaml = fs.readFileSync(yamlPath, "utf-8");
const llmBlock = yaml.slice(yaml.indexOf("\nllm:"));
const field = (k: string) => (llmBlock.match(new RegExp(`\\n\\s+${k}:\\s*"?([^"\\n]+)"?`)) ?? [])[1]?.trim() ?? "";
const base = new StandaloneLLMRunnerFactory({
  config: {
    baseUrl: field("baseUrl").replace("host.docker.internal", "127.0.0.1"),
    apiKey: field("apiKey"),
    model: field("model"),
    maxTokens: Number(field("maxTokens")) || 32000,
    timeoutMs: TIMEOUT_MS,
    stream: false,
  },
  logger,
}).createRunner({ enableTools: true });
const runner = { run: (p: Record<string, unknown>) => base.run({ ...p, timeoutMs: TIMEOUT_MS } as never) };

const db = new DatabaseSync(path.join(coreData, "vectors.db"), { readOnly: true });
const table = db.prepare("select record_id, agent_id, session_key from l1_records").all() as Array<{
  record_id: string;
  agent_id: string;
  session_key: string;
}>;
db.close(); // an open handle while memory-core starts makes it fail with a disk I/O error

const targets = new Set([...new Set(table.map((r) => r.agent_id))].filter((a) => !skip.has(a) && (!only.size || only.has(a))));
const recordsDir = path.join(coreData, "records");
const logTexts = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".jsonl")).sort()
  .map((f) => fs.readFileSync(path.join(recordsDir, f), "utf-8"));
const byAgent = new Map<string, L1Row[]>();
for (const r of assignL1Records(parseL1Log(logTexts), table, targets)) {
  byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);
}

const profilesDir = path.join(coreData, "profiles");
const dirOf = new Map(fs.readdirSync(profilesDir).map((d) => [decodeURIComponent(d).split("agent:")[1] ?? "", path.join(profilesDir, d)]));
const agents = [...byAgent.keys()].filter((a) => dirOf.has(a)).sort((a, b) => byAgent.get(a)!.length - byAgent.get(b)!.length);
log(`plan: ${agents.map((a) => `${a}=${byAgent.get(a)!.length}`).join(" ")}`);
if (process.env.DRY) process.exit(0);

for (const agent of agents) {
  const dir = dirOf.get(agent)!;
  const rows = byAgent.get(agent)!;
  log(`== ${agent}: ${rows.length} L1`);
  fs.rmSync(path.join(dir, "scene_blocks"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "persona.md"), { force: true });
  fs.rmSync(path.join(dir, ".metadata", "checkpoint.json"), { force: true });
  fs.rmSync(path.join(dir, ".metadata", "scene_index.json"), { force: true });

  const ex = new SceneExtractor({ dataDir: dir, config: undefined, promptMode: "code", maxScenes: 15, llmRunner: runner as never, logger });
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({ content: r.content, created_at: r.created_time, id: r.record_id }));
    const t = Date.now();
    const res = await ex.extract(batch);
    log(`  L2 batch ${i / BATCH + 1}/${Math.ceil(rows.length / BATCH)}: ${res.success ? "ok" : `FAILED ${res.error}`} (${Math.round((Date.now() - t) / 1000)}s)`);
  }

  const gen = new PersonaGenerator({ dataDir: dir, config: undefined, promptMode: "code", llmRunner: runner as never, logger });
  for (let i = 0; i < 10; i++) {
    const ok = await gen.generate(`rebuild ${i + 1}`);
    log(`  L3 run ${i + 1}: ${ok ? "written" : "skipped"}`);
    if (!ok || !gen.coveredUntil) break;
  }
}
log("DONE");
