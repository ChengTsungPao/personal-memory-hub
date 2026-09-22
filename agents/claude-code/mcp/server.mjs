#!/usr/bin/env node
/**
 * MemoryCore MCP server (stdio) — on-demand memory access for Claude Code.
 *
 * The hooks handle the automatic half of memory: `Stop` captures every turn
 * into L0, `SessionStart` injects the L3 persona and the L2 index. This server
 * handles the deliberate half — searching older memory when a question needs
 * it, and writing curated scenario blocks and persona updates.
 *
 * JSON-RPC 2.0 over stdio is implemented directly rather than via
 * @modelcontextprotocol/sdk so the file has zero dependencies and can be
 * registered with `claude mcp add` without an install step.
 */

import { loadConfig } from "../lib/config.mjs";
import { CoreClient } from "../lib/core-client.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const cfg = loadConfig();
const client = new CoreClient(cfg);

// ── Tool definitions ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search the user's long-term memory across raw conversations (L0) and extracted " +
      "atoms (L1). Use when the current session lacks context the user expects you to " +
      "know — past decisions, preferences, prior work on a topic.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        limit: { type: "number", description: "Max results per layer (default 10)." },
        layer: {
          type: "string",
          enum: ["both", "conversations", "atoms"],
          description: "Which layer to search. Default 'both'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "scenario_list",
    description:
      "List the L2 scenario blocks — the per-project/topic knowledge files. Returns paths " +
      "and summaries so you can decide which to read.",
    inputSchema: {
      type: "object",
      properties: {
        path_prefix: { type: "string", description: "Optional directory prefix to narrow the listing." },
      },
    },
  },
  {
    name: "scenario_read",
    description: "Read one L2 scenario block by its path (as returned by scenario_list).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Scenario block path, e.g. 'scene_blocks/postgres.md'." } },
      required: ["path"],
    },
  },
  {
    name: "scenario_write",
    description:
      "Create or replace an L2 scenario block. Use to record durable knowledge about a " +
      "project or topic that should survive this session. Write Markdown. Replaces the " +
      "whole file, so read it first when amending.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path ending in .md, e.g. 'scene_blocks/postgres.md'." },
        content: { type: "string", description: "Full Markdown content of the block." },
        summary: { type: "string", description: "One-line summary shown in listings." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "core_read",
    description:
      "Read the L3 core persona — the user's stable long-term profile. Returns null content " +
      "when nothing has been written yet.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "core_write",
    description:
      "Replace the L3 core persona. This is the highest-value, lowest-volume memory: stable " +
      "preferences, working style, standing constraints. Read it first and amend — this " +
      "overwrites the whole document.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "Full Markdown persona document." } },
      required: ["content"],
    },
  },
];

// ── Tool implementations ────────────────────────────────────────────────

async function callTool(name, args = {}) {
  switch (name) {
    case "memory_search": {
      const limit = args.limit ?? 10;
      const layer = args.layer ?? "both";
      const out = {};
      const jobs = [];
      if (layer === "both" || layer === "conversations") {
        jobs.push(
          client
            .searchConversation(args.query, limit)
            .then((d) => { out.conversations = d; })
            .catch((e) => { out.conversations = { error: e.message }; }),
        );
      }
      if (layer === "both" || layer === "atoms") {
        jobs.push(
          client
            .searchAtomic(args.query, limit)
            .then((d) => { out.atoms = d; })
            .catch((e) => { out.atoms = { error: e.message }; }),
        );
      }
      await Promise.all(jobs);
      return out;
    }

    case "scenario_list":
      return client.listScenarios(args.path_prefix);

    case "scenario_read":
      return client.readScenario(args.path);

    case "scenario_write":
      return client.writeScenario(args.path, args.content, args.summary);

    case "core_read":
      return client.readCore();

    case "core_write":
      return client.writeCore(args.content);

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── JSON-RPC plumbing ───────────────────────────────────────────────────

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(request) {
  const { id, method, params } = request;

  // Notifications carry no id and expect no reply.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "memorycore", version: "0.1.0" },
      });

    case "ping":
      return respond(id, {});

    case "tools/list":
      return respond(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name;
      try {
        const data = await callTool(toolName, params?.arguments ?? {});
        return respond(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
      } catch (err) {
        // Report tool failures as results, not protocol errors, so the model
        // can read the reason and choose what to do.
        return respond(id, {
          content: [{ type: "text", text: `Error calling ${toolName}: ${err?.message ?? err}` }],
          isError: true,
        });
      }
    }

    default:
      return respondError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue; // ignore malformed frames rather than dying mid-session
    }
    handle(request).catch((err) => {
      if (request?.id != null) respondError(request.id, -32603, err?.message ?? String(err));
    });
  }
});

process.stdin.on("end", () => process.exit(0));
