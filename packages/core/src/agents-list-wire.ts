/**
 * The GET /api/agents wire contract, defined ONCE (GH#310).
 *
 * The daemon 400s on unknown parameter names and bad values, so the mapping
 * from client options to query keys is load-bearing — and it is REPOSITORY-
 * WIDE: the cli route parser and ApiClient, the OpenClaw adapter, and the
 * MCP client all derive their vocabulary from this one module, so a change
 * to the filter surface breaks every consumer's compile instead of drifting
 * silently in whichever package was not edited.
 */

export const AGENT_CONNECTION_STATUSES = ['self', 'connected', 'disconnected'] as const;
export type AgentConnectionStatus = (typeof AGENT_CONNECTION_STATUSES)[number];

/** Filters that narrow the list without truncating it. */
export interface AgentListFilters {
  framework?: string;
  skillType?: string;
  connectionStatus?: AgentConnectionStatus;
  local?: boolean;
}

/** {@link AgentListFilters} plus the truncating/pagination controls. */
export interface AgentListPageOptions extends AgentListFilters {
  limit?: number;
  /** Opaque cursor from a previous response. Repeat the same filters. */
  cursor?: string;
}

/**
 * Option name -> query parameter name. `satisfies` makes the map total: an
 * option added to {@link AgentListPageOptions} without a wire key is a
 * compile error, and there is exactly one place a spelling can live.
 */
export const AGENT_LIST_WIRE_KEYS = {
  framework: 'framework',
  skillType: 'skill_type',
  connectionStatus: 'connectionStatus',
  local: 'local',
  limit: 'limit',
  cursor: 'cursor',
} as const satisfies Record<keyof AgentListPageOptions, string>;

/** The query parameter names the endpoint accepts, in wire spelling. */
export const AGENT_LIST_WIRE_KEY_VALUES: readonly string[] = Object.values(AGENT_LIST_WIRE_KEYS);

/** Serialize options through the one key map. `undefined` means "omit". */
export function serializeAgentListOptions(options: AgentListPageOptions): string {
  const params = new URLSearchParams();
  for (const option of Object.keys(AGENT_LIST_WIRE_KEYS) as Array<keyof AgentListPageOptions>) {
    const value = options[option];
    if (value !== undefined) params.set(AGENT_LIST_WIRE_KEYS[option], String(value));
  }
  return params.toString();
}
