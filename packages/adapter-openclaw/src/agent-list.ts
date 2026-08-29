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
 * The dkg_find_agents JSON-schema properties — THE canonical declaration of
 * the tool vocabulary. messaging-tools assigns this object into the tool
 * definition directly, and the argument type plus the serializer mapping are
 * DERIVED from it, so adding an argument is one edit here plus its mapping —
 * which the compiler then demands.
 */
export const FIND_AGENTS_TOOL_SCHEMA_PROPERTIES = {
  framework: { type: 'string', description: 'Filter by framework (e.g. "OpenClaw", "ElizaOS").' },
  skill_type: { type: 'string', description: 'Filter by skill type URI (e.g. "ImageAnalysis").' },
  connection_status: {
    type: 'string',
    enum: ['self', 'connected', 'disconnected'],
    description: 'Only agents in this live connection state.',
  },
  local: {
    type: 'boolean',
    description: "Only this node's own agents — the cheap way to learn your own agent address.",
  },
  limit: {
    type: 'integer',
    minimum: 1,
    description: 'Page size; the response carries nextCursor while rows remain.',
  },
  cursor: {
    type: 'string',
    description: 'Opaque cursor from a previous response; repeat the same filters.',
  },
} as const;

/** Derived, not maintained: the schema object's keys ARE the vocabulary. */
export type FindAgentsToolArg = keyof typeof FIND_AGENTS_TOOL_SCHEMA_PROPERTIES;

/**
 * dkg_find_agents tool arg -> canonical option. EXHAUSTIVE over the derived
 * vocabulary, and values are OPTION KEYS, so the wire spelling is always
 * looked up through {@link OPTION_WIRE_KEYS} — an argument advertised in the
 * schema without a mapping here does not compile.
 */
export const RAW_ARG_TO_OPTION = {
  framework: 'framework',
  skill_type: 'skillType',
  connection_status: 'connectionStatus',
  local: 'local',
  limit: 'limit',
  cursor: 'cursor',
} as const satisfies Record<FindAgentsToolArg, CanonicalOption>;

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
 * Serialize UNVALIDATED tool arguments — EVERY supplied argument reaches the
 * daemon. Known names are translated to their wire spelling; unknown names
 * are forwarded AS-IS so a misspelled key surfaces the daemon's
 * unknown-parameter 400 instead of silently widening the query (`limt: 5`
 * must not become the full ~150 KB registry). Supplied values are forwarded
 * verbatim, empty strings included (`cursor: ""` must produce the daemon's
 * invalid-cursor 400, not the first page). Only `undefined` and `null` mean
 * "absent" — the JSON-Schema omit-or-null convention.
 */
export function serializeRawAgentListArgs(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [rawKey, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const wireKey = Object.hasOwn(RAW_ARG_TO_OPTION, rawKey)
      ? OPTION_WIRE_KEYS[RAW_ARG_TO_OPTION[rawKey as FindAgentsToolArg]]
      : rawKey;
    params.set(wireKey, String(value));
  }
  return params.toString();
}
