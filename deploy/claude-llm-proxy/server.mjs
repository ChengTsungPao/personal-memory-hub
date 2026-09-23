#!/usr/bin/env node
/**
 * claude-llm-proxy — lets MemoryCore's L1 extraction run on a Claude Pro/Max
 * subscription instead of a separate API key or local model.
 *
 * MemoryCore's StandaloneLLMRunner (see MemoryCore/src/adapters/standalone/
 * llm-runner.ts) always speaks a plain OpenAI-compatible `/chat/completions`
 * HTTP request — it has no concept of a CLI subprocess. This server exposes
 * exactly that HTTP shape, and on each request shells out to `claude -p`
 * (headless/print mode), which authenticates via CLAUDE_CODE_OAUTH_TOKEN
 * (a subscription-backed token from `claude setup-token`, NOT an API key).
 * MemoryCore never knows the difference.
 *
 * Tool-calling (L2 scene extraction, L3 persona generation): MemoryCore's AI
 * SDK sends real OpenAI-protocol `tools` + expects `tool_calls` back, then
 * executes them ITSELF (sandboxed read/write/edit against its own
 * workspaceDir, which this proxy has no filesystem access to — it's inside
 * the memory-core container). So this proxy can't just let `claude -p` use
 * its own native Read/Write/Edit tools directly; instead every native tool
 * is disallowed, and a system-prompt addendum tells the model to emit
 * `{"tool_call": {"name":..., "arguments":{...}}}` as its entire response
 * when it wants to call one instead of actually calling anything. That
 * gets translated into a real OpenAI `tool_calls` response; MemoryCore
 * executes it for real and sends the result back as a `role:"tool"`
 * message, which this proxy resumes the *same* `claude -p` session with
 * (`--resume <session-id>`, verified to retain context across calls) so
 * the model can see the result and decide its next move. `toolSessions`
 * (in-memory, proxy-process-lifetime) maps each fabricated tool_call id to
 * the real claude session id it belongs to.
 *
 * CLAUDE_CONFIG_DIR is pointed at ./claude-config (isolated, empty of hooks/
 * MCP servers/CLAUDE.md) so these calls never touch the user's real
 * ~/.claude/ state or trigger the memory-capture/memory-recall hooks.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(__dirname, ".env"));
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || fileEnv.CLAUDE_CODE_OAUTH_TOKEN;
const DEFAULT_MODEL = process.env.CLAUDE_LLM_PROXY_MODEL || fileEnv.CLAUDE_LLM_PROXY_MODEL || "sonnet";
const PORT = Number(process.env.CLAUDE_LLM_PROXY_PORT || fileEnv.CLAUDE_LLM_PROXY_PORT || 8622);

const CONFIG_DIR = path.join(__dirname, "claude-config");
const WORKDIR = path.join(__dirname, "workdir");

if (!OAUTH_TOKEN) {
  console.error("[claude-llm-proxy] CLAUDE_CODE_OAUTH_TOKEN missing — fill it into .env (see .env.example).");
  process.exit(1);
}

const SUBPROCESS_TIMEOUT_MS = 170_000; // stays under MemoryCore's 180s hard extraction timeout

// ============================
// Call log — cost/usage visibility
// ============================
//
// `total_cost_usd` from `claude -p` is Anthropic's list-price-equivalent for
// the tokens used, computed the same way whether billed per-call (API key) or
// drawn from a subscription's 5-hour rolling quota (our case). It's not a
// separate bill, but it IS the same accounting Claude Code itself uses for
// interactive sessions — so it's a valid basis for comparing "how much of my
// quota is memory extraction eating" against normal interactive usage.
const LOG_FILE = path.join(__dirname, "calls.jsonl");

function logCall(entry) {
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("[claude-llm-proxy] failed to write call log:", err.message);
  }
}

function readCallLog() {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function buildStats() {
  const entries = readCallLog();
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  function summarize(rows) {
    const byModel = {};
    let costUsd = 0, promptTokens = 0, completionTokens = 0, errors = 0;
    for (const r of rows) {
      costUsd += r.costUsd ?? 0;
      promptTokens += r.promptTokens ?? 0;
      completionTokens += r.completionTokens ?? 0;
      if (r.error) errors += 1;
      const m = byModel[r.model] ?? (byModel[r.model] = { calls: 0, costUsd: 0 });
      m.calls += 1;
      m.costUsd += r.costUsd ?? 0;
    }
    return { calls: rows.length, errors, costUsd, promptTokens, completionTokens, byModel };
  }

  return {
    today: summarize(entries.filter((e) => now - e.ts < DAY_MS)),
    last7Days: summarize(entries.filter((e) => now - e.ts < 7 * DAY_MS)),
    allTime: summarize(entries),
    note:
      "costUsd is Anthropic's list-price equivalent for tokens consumed via claude -p " +
      "(same accounting as interactive Claude Code sessions), drawn from the same " +
      "subscription quota — not a separate charge.",
  };
}

function extractSystemAndPrompt(messages) {
  const systemParts = [];
  const userParts = [];
  for (const m of messages ?? []) {
    if (m.role === "system") systemParts.push(m.content);
    else if (m.role === "user") userParts.push(m.content);
    // MemoryCore's StandaloneLLMRunner (enableTools:false) always sends exactly
    // one system + one user message (see llm-runner.ts `system`/`prompt`
    // params) — assistant/tool messages never occur on this path.
  }
  return { system: systemParts.join("\n\n"), prompt: userParts[userParts.length - 1] ?? "" };
}

// ============================
// Tool-calling emulation (L2/L3)
// ============================

/** fabricated tool_call id -> real `claude -p` session id it belongs to. */
const toolSessions = new Map();

function buildToolSystemPromptAddendum(tools) {
  const lines = (tools ?? [])
    .filter((t) => t.type === "function" && t.function)
    .map((t) => {
      const f = t.function;
      return `- ${f.name}(${JSON.stringify(f.parameters ?? {})}): ${f.description ?? ""}`;
    });
  return [
    "",
    "--- TOOL USE PROTOCOL ---",
    "Ignore any tools that appear to be available to you in this runtime (ListAgents, ScheduleWakeup, ToolSearch, or " +
    "anything else) — none of them are relevant here and none of them can accomplish this task. Do not call any of " +
    "them, do not search for other tools, and do not explain that a tool is missing. The ONLY way to affect the " +
    "outside world in this task is the plain-text JSON protocol described below — nothing else you might notice " +
    "being available actually does anything for this task.",
    "",
    "You need these tools, which do not exist as real callable functions — you invoke them purely by writing JSON, " +
    "as specified below. Available tools, as name(JSON schema): description:",
    ...lines,
    "",
    "To call exactly ONE tool, your ENTIRE response must be a single JSON object and nothing else — no markdown fencing, no explanation before or after:",
    '{"tool_call": {"name": "<tool name>", "arguments": { ...matching that tool\'s schema... }}}',
    "You will be told the tool's result in the next turn, after which you may call another tool the same way, or, once you have everything you need, give your final answer as plain text (no JSON, no wrapper) — exactly the format the rest of these instructions describe.",
  ].join("\n");
}

/** Returns {name, arguments} if `text` is (only) a tool-call JSON object, else null. */
function tryParseToolCall(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const call = parsed?.tool_call;
  if (!call || typeof call.name !== "string" || typeof call.arguments !== "object") return null;
  return call;
}

function runClaude({ system, prompt, model, resumeSessionId }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", model,
      "--strict-mcp-config",   // don't load the user's real MCP servers
      "--restricted",          // no Bash/PowerShell/REPL/code-exec tools, no WebFetch
      // Tool-calling mode disallows Claude's OWN file tools too: MemoryCore's
      // AI SDK is the one meant to execute reads/writes, against its own
      // workspaceDir this proxy can't see — see file header.
      "--disallowed-tools", "WebSearch Read Write Edit Glob Grep Task",
    ];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    } else {
      args.push("--system-prompt", system);
    }

    const child = spawn("claude", args, {
      cwd: WORKDIR,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: CONFIG_DIR,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
      },
      shell: false,
      // claude -p otherwise waits ~3s to see if stdin has data before proceeding.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p timed out after ${SUBPROCESS_TIMEOUT_MS}ms`));
    }, SUBPROCESS_TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(`claude produced non-JSON output: ${stdout.slice(0, 500)}`));
      }
      if (parsed.is_error) {
        return reject(new Error(`claude reported an error: ${parsed.result ?? "unknown"}`));
      }
      resolve(parsed);
    });
  });
}

function openAiResponse({ model, text, usage }) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

function openAiToolCallResponse({ model, name, args, usage, sessionId }) {
  const callId = `call_${crypto.randomUUID()}`;
  toolSessions.set(callId, sessionId);
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

function openAiError(status, message) {
  return { status, body: { error: { message, type: "claude_llm_proxy_error" } } };
}

// ============================
// Backend-switch control — lets the Panel's web UI flip MemoryCore's
// MEMORY_LLM_* between this proxy and local Ollama/Qwen, without a terminal.
// Shells out to the same switch-llm-backend.sh a human would run by hand.
// ============================

const SWITCH_SCRIPT = path.join(__dirname, "..", "global-images", "switch-llm-backend.sh");

function runSwitchScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SWITCH_SCRIPT, ...args], {
      cwd: path.dirname(SWITCH_SCRIPT),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("switch-llm-backend.sh timed out after 90s"));
    }, 90_000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out).slice(-1000) || `exit ${code}`));
      resolve(out + err);
    });
  });
}

async function handleControlRequest(req, res) {
  if (req.method === "GET" && req.url === "/control/backend") {
    try {
      const out = await runSwitchScript(["status"]);
      const mode = out.includes("proxy") ? "proxy" : out.includes("qwen") ? "qwen" : "unknown";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mode, detail: out.trim() }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/control/backend") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return true;
    }
    if (body.mode !== "proxy" && body.mode !== "qwen") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: 'mode must be "proxy" or "qwen"' }));
      return true;
    }
    try {
      const out = await runSwitchScript([body.mode]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: body.mode, detail: out.trim() }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(buildStats(), null, 2));
  }

  if (req.url === "/control/backend" && (await handleControlRequest(req, res))) {
    return;
  }

  if (req.method !== "POST" || !req.url.startsWith("/chat/completions") && !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404);
    return res.end();
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const { status, body: errBody } = openAiError(400, "invalid JSON body");
    res.writeHead(status, { "content-type": "application/json" });
    return res.end(JSON.stringify(errBody));
  }

  const model = body.model || DEFAULT_MODEL;
  const startedAt = Date.now();
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const lastMessage = (body.messages ?? [])[(body.messages ?? []).length - 1];
  const isToolContinuation = hasTools && lastMessage?.role === "tool";

  let system, prompt, resumeSessionId;

  if (isToolContinuation) {
    const sid = toolSessions.get(lastMessage.tool_call_id);
    if (!sid) {
      const { status, body: errBody } = openAiError(
        409,
        `no known claude session for tool_call_id ${lastMessage.tool_call_id} — proxy was likely restarted mid-conversation`,
      );
      res.writeHead(status, { "content-type": "application/json" });
      return res.end(JSON.stringify(errBody));
    }
    resumeSessionId = sid;
    prompt = typeof lastMessage.content === "string" ? lastMessage.content : JSON.stringify(lastMessage.content);
  } else {
    const extracted = extractSystemAndPrompt(body.messages);
    prompt = extracted.prompt;
    system = hasTools ? extracted.system + buildToolSystemPromptAddendum(body.tools) : extracted.system;
  }

  if (!prompt) {
    const { status, body: errBody } = openAiError(400, "no user message found in request");
    res.writeHead(status, { "content-type": "application/json" });
    return res.end(JSON.stringify(errBody));
  }

  try {
    const result = await runClaude({ system, prompt, model, resumeSessionId });
    logCall({
      ts: startedAt,
      model,
      durationMs: Date.now() - startedAt,
      costUsd: result.total_cost_usd ?? 0,
      promptTokens: result.usage?.input_tokens ?? 0,
      completionTokens: result.usage?.output_tokens ?? 0,
    });

    const toolCall = hasTools ? tryParseToolCall(result.result ?? "") : null;
    const responseBody = toolCall
      ? openAiToolCallResponse({
          model, name: toolCall.name, args: toolCall.arguments,
          usage: result.usage, sessionId: result.session_id,
        })
      : openAiResponse({ model, text: result.result ?? "", usage: result.usage });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  } catch (err) {
    console.error("[claude-llm-proxy] request failed:", err.message);
    logCall({ ts: startedAt, model, durationMs: Date.now() - startedAt, costUsd: 0, error: err.message });
    const { status, body: errBody } = openAiError(500, err.message);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(errBody));
  }
});

server.listen(PORT, () => {
  console.log(`[claude-llm-proxy] listening on :${PORT}, model=${DEFAULT_MODEL}, config-dir=${CONFIG_DIR}`);
});
