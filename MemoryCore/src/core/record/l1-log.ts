/**
 * Read L1 history from the append-only JSONL log (`records/*.jsonl`).
 *
 * The l1_records table only holds live records: a dedup merge/update deletes its targets from it,
 * while the log keeps every version. Rebuilding L2 from the table alone therefore loses the detail
 * the incremental L2 had absorbed from the merged-away records.
 */

export interface L1LogRecord {
  id: string;
  content: string;
  createdAt: string;
  sessionKey?: string;
  agentId?: string;
}

export interface L1Row {
  record_id: string;
  content: string;
  created_time: string;
  agent_id: string;
}

/** Parse JSONL text; later lines replace earlier ones with the same id. Blank or partial lines are skipped. */
export function parseL1Log(texts: string[]): Map<string, L1LogRecord> {
  const out = new Map<string, L1LogRecord>();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as L1LogRecord;
        if (r.id && typeof r.content === "string") out.set(r.id, r);
      } catch {
        // partial line from an interrupted append
      }
    }
  }
  return out;
}

/**
 * Assign each log record to the block that owns it now: the table's agent_id when the record is
 * still live, else the single block that owns its session (records move with their session),
 * else the agentId the log recorded. Records outside `targets` and duplicate contents within a
 * block are dropped. Result is sorted by creation time.
 */
export function assignL1Records(
  log: Map<string, L1LogRecord>,
  table: Array<{ record_id: string; agent_id: string; session_key: string }>,
  targets: Set<string>,
): L1Row[] {
  const tableAgent = new Map(table.map((r) => [r.record_id, r.agent_id]));
  const sessionAgents = new Map<string, Set<string>>();
  for (const r of table) sessionAgents.set(r.session_key, (sessionAgents.get(r.session_key) ?? new Set()).add(r.agent_id));

  const rows: L1Row[] = [];
  const seen = new Set<string>();
  for (const r of log.values()) {
    const owners = sessionAgents.get(r.sessionKey ?? "");
    const agent = tableAgent.get(r.id) ?? (owners?.size === 1 ? [...owners][0] : r.agentId);
    if (!agent || !targets.has(agent)) continue;
    const key = `${agent}\u0000${r.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ record_id: r.id, content: r.content, created_time: r.createdAt, agent_id: agent });
  }
  return rows.sort((a, b) => a.created_time.localeCompare(b.created_time));
}
