/**
 * The adapter's ONE agent-list boundary (GH#310).
 *
 * Everything that knows the GET /api/agents wire contract lives here: the
 * strict SDK option model, the canonical option→query-key map, and the two
 * serializers — typed options for SDK callers, verbatim raw values for the
 * tool boundary. Both paths run through the same wire map, so a spelling
 * cannot change for one caller and not the other; the raw map's values are
 * option keys, giving the two maps a compiler-checked relationship.
 *
 * The daemon is the single validator (it 400s on bad values AND unknown
 * parameter names), which is why the raw path forwards model-produced values
 * VERBATIM: a `limit: 0` coerced or dropped client-side would silently
 * return the full ~150 KB registry instead of the daemon's 400.
 */

/** Strict options for {@link DkgClient.getAgents}. */
export interface AgentListOptions {
  framework?: string;
  skillType?: string;
  /**
   * @deprecated Use `skillType`. Compatibility alias from the pre-GH#310
   * signature; both spellings serialize to the daemon's `skill_type`.
   * Supplying both with different values is an error.
   */
  skill_type?: string;
  connectionStatus?: 'self' | 'connected' | 'disconnected';
  local?: boolean;
  limit?: number;
  cursor?: string;
}

type CanonicalOption = Exclude<keyof AgentListOptions, 'skill_type'>;

/** Canonical option -> query parameter. `satisfies` keeps the map total. */
const OPTION_WIRE_KEYS = {
  framework: 'framework',
  skillType: 'skill_type',
  connectionStatus: 'connectionStatus',
  local: 'local',
  limit: 'limit',
  cursor: 'cursor',
} as const satisfies Record<CanonicalOption, string>;

/**
 * dkg_find_agents tool arg -> canonical option. Values are OPTION KEYS, so
 * the wire spelling below is always looked up through {@link OPTION_WIRE_KEYS}
 * — the compiler ties the two maps together.
 */
const RAW_ARG_TO_OPTION = {
  framework: 'framework',
  skill_type: 'skillType',
  connection_status: 'connectionStatus',
  local: 'local',
  limit: 'limit',
  cursor: 'cursor',
} as const satisfies Record<string, CanonicalOption>;

/** Serialize strict SDK options. `undefined` means "omit". */
export function serializeAgentListOptions(options: AgentListOptions): string {
  const { skill_type: deprecatedSkillType, ...rest } = options;
  if (
    deprecatedSkillType !== undefined &&
    rest.skillType !== undefined &&
    deprecatedSkillType !== rest.skillType
  ) {
    throw new Error(
      "Conflicting skill filters: 'skillType' and the deprecated 'skill_type' alias differ",
    );
  }
  const canonical: Record<CanonicalOption, unknown> = {
    ...rest,
    skillType: rest.skillType ?? deprecatedSkillType,
  } as Record<CanonicalOption, unknown>;
  const params = new URLSearchParams();
  for (const option of Object.keys(OPTION_WIRE_KEYS) as CanonicalOption[]) {
    const value = canonical[option];
    if (value !== undefined) params.set(OPTION_WIRE_KEYS[option], String(value));
  }
  return params.toString();
}

/**
 * Serialize UNVALIDATED tool arguments verbatim. Only known arg names are
 * read (the daemon rejects unknown parameter names anyway); values pass
 * through `String()` untouched so the daemon's 400 is the caller's signal.
 */
export function serializeRawAgentListArgs(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const rawKey of Object.keys(RAW_ARG_TO_OPTION) as Array<keyof typeof RAW_ARG_TO_OPTION>) {
    const value = args[rawKey];
    if (value !== undefined && value !== null && value !== '') {
      params.set(OPTION_WIRE_KEYS[RAW_ARG_TO_OPTION[rawKey]], String(value));
    }
  }
  return params.toString();
}
