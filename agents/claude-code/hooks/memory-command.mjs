#!/usr/bin/env node
/**
 * UserPromptSubmit hook — `mem: repo …` commands that edit which repos this session's memory block
 * belongs to (see lib/session.mjs):
 *
 *   mem: repo              show the current binding
 *   mem: repo add <x>      add a repo by path or by the name of a repo that already has memory
 *   mem: repo rm <x>       remove a repo by name or hash prefix; it is not added back automatically
 *
 * A matching prompt is answered here and not sent to the model ("decision":"block" shows the
 * reason to the user). Any other prompt passes through untouched, and every failure exits 0.
 */

import { openSession, editRepos, describeBinding } from "../lib/session.mjs";

const COMMAND = /^\s*mem:\s*repo(?:\s+(add|rm)\b)?\s*(.*)$/is;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const match = COMMAND.exec(payload.prompt ?? "");
  if (!match) return;

  const reply = (reason) => process.stdout.write(JSON.stringify({ decision: "block", reason }));
  const [, op, arg] = match;
  try {
    const { cfg, binding, skip } = await openSession(payload.session_id, payload.cwd);
    if (skip || !binding) return reply("這個 session 沒有自己的記憶塊（沒有 admin key，或設了 TDAI_AGENT_ID）");
    const result = op ? await editRepos(cfg, payload.session_id, payload.cwd, op.toLowerCase(), arg) : binding;
    reply(describeBinding(result));
  } catch (err) {
    reply(err?.message ?? String(err));
  }
}

main()
  .catch((err) => {
    if (process.env.TDAI_DEBUG === "1") console.error("[tdai-hook] command failed:", err?.message ?? err);
  })
  .finally(() => process.exit(0));
