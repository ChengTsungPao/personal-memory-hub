/**
 * Agents in the session-memory-block model (agents/claude-code/lib/session.mjs), told apart by
 * `kind` in their metadata_json:
 *   - `repo`: one per repository (root commit hash);
 *   - `new-chat`: the sessions with no repository;
 *   - `session`: one hidden agent per session, holding that session's memory block, bound to its
 *     repo agents or New-chat.
 *
 * The asset pages (Chat_Memory, Skill, Code_Graph, Wiki) and Agents list offer the repo agents and
 * New-chat. The default agent and the agents from before session blocks have no kind.
 */

type WithMeta = { metadata_json?: string | null };

export function agentKind(agent: WithMeta): string | undefined {
  try {
    return JSON.parse(agent.metadata_json || '{}')?.kind;
  } catch {
    return undefined;
  }
}

export function isSessionAgent(agent: WithMeta): boolean {
  return agentKind(agent) === 'session';
}

/** A repo agent or New-chat: the agents the asset pages offer. */
export function isRepoOrNewChatAgent(agent: WithMeta): boolean {
  const kind = agentKind(agent);
  return kind === 'repo' || kind === 'new-chat';
}

/**
 * A repo agent or New-chat by name. Two different repos can share a name (forks, same folder
 * name): only then add the repo's short root commit hash.
 */
export function repoAgentLabel(agent: WithMeta & { name: string }, all: Array<{ name: string }>): string {
  if (all.filter((a) => a.name === agent.name).length < 2) return agent.name;
  try {
    const root = JSON.parse(agent.metadata_json || '{}')?.root_commit;
    return root ? `${agent.name}（${String(root).slice(0, 7)}）` : agent.name;
  } catch {
    return agent.name;
  }
}

/** An agent's name, with its id only when another listed agent has the same name. */
export function nameLabel(agent: { name: string; id: string }, all: Array<{ name: string }>): string {
  return all.filter((a) => a.name === agent.name).length < 2 ? agent.name : `${agent.name}（${agent.id}）`;
}

/** A repo agent's link (recorded by the hooks from the repo's origin remote), or "". */
export function repoUrl(agent: WithMeta | undefined): string {
  if (!agent) return '';
  try {
    const url = JSON.parse(agent.metadata_json || '{}')?.url;
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : '';
  } catch {
    return '';
  }
}

/** A repo agent's short root commit hash (its identity), or "". */
export function repoHash(agent: WithMeta | undefined): string {
  if (!agent) return '';
  try {
    const root = JSON.parse(agent.metadata_json || '{}')?.root_commit;
    return typeof root === 'string' ? root.slice(0, 7) : '';
  } catch {
    return '';
  }
}
