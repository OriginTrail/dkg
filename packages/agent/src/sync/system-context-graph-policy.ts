import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { parseBooleanEnv } from './agents-meta-policy.js';

export interface AutomaticSystemContextGraphSyncOptions {
  nodeRole?: 'core' | 'edge';
  configValue?: boolean;
  envValue?: string;
}

/**
 * Core nodes retain the complete network catalogue needed for hosting, while
 * Edge nodes fetch only graphs their operator selected. Explicit catch-up and
 * the live system GossipSub subscriptions are outside this policy.
 */
export function resolveAutomaticSystemContextGraphSync(
  options: AutomaticSystemContextGraphSyncOptions,
): boolean {
  const envValue = parseBooleanEnv(options.envValue);
  if (envValue !== undefined) return envValue;
  if (options.configValue !== undefined) return options.configValue;
  return options.nodeRole === 'core';
}

export function automaticDurableSyncContextGraphs(
  selectedContextGraphIds: readonly string[],
  options: AutomaticSystemContextGraphSyncOptions,
): string[] {
  const ordered = resolveAutomaticSystemContextGraphSync(options)
    ? [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, ...selectedContextGraphIds]
    : [...selectedContextGraphIds];
  return [...new Set(ordered)];
}

/**
 * System Context Graphs excluded from the OT-RFC-59 changelog lane, i.e. the
 * ones that ride the legacy durable lane whatever the peer advertises.
 *
 * `ontology` is deliberately ABSENT rather than cleared. Its changelog
 * disposition has not been decided and belongs to the ontology-plane work; do
 * not read its absence here as "we considered it and let it ride the lane."
 * That distinction is the reason this list exists as a policy rather than as an
 * inline comparison — an identity test has nowhere to record an open question.
 */
const CHANGELOG_LANE_EXCLUDED_SYSTEM_CONTEXT_GRAPHS: readonly string[] = [
  SYSTEM_CONTEXT_GRAPHS.AGENTS,
];

/**
 * Does this Context Graph stay on the legacy durable lane instead of riding the
 * OT-RFC-59 changelog lane?
 *
 * This answers a POLICY question — "may this graph ride the changelog lane?" —
 * which is deliberately not the IDENTITY question `isAgentRegistryContextGraph`
 * answers ("is this the agent registry?"). They share an answer today and are
 * still different questions.
 *
 * WHY `agents` IS EXCLUDED (#2052 D-13). `isPrivateContextGraph` returns false
 * for system Context Graphs, so without this the graph is carried down
 * `applyPage` by any peer advertising the changelog protocol. The fix is
 * routing rather than a gate because the merkle bypass sits on BOTH doors:
 * `acceptUnverified` is computed from system-CG membership in the changelog
 * lane and the identical predicate is computed in the legacy runner under the
 * name `isSystemContextGraph`, both feeding the shared
 * `selectVerifiedDurableSyncQuads`. And it does more than skip a precondition —
 * it ADMITS mismatched content as verified. A gate would therefore sit
 * downstream of a selector that had already accepted the quads.
 *
 * Withholding quads at `applyPage` is unsafe here rather than merely harder:
 * `planPageApply` advances a contiguous-prefix cursor with two record
 * dispositions, so a withhold-but-advance third shape makes the withholding
 * PERMANENT past a passed sequence. Excluding the graph means no changelog
 * cursor is ever established for it, which is the only shape that stays
 * reversible.
 *
 * DRIFT WARNING — the reason this is a named policy and not a branch. Lane
 * exclusion (this set) and verification posture (`acceptUnverified`, which keys
 * on membership of the WHOLE `SYSTEM_CONTEXT_GRAPHS` set) are related policies
 * maintained in SEPARATE places. A system Context Graph added tomorrow joins
 * the verification-bypass set automatically and this set not at all, so it
 * silently inherits `ontology`'s posture. Adding a member to
 * `SYSTEM_CONTEXT_GRAPHS` therefore obliges an explicit decision here, and
 * nothing in the type system will ask for it.
 *
 * Pure by construction: no store reads, no async. The private-graph divert is a
 * separate, asynchronous decision and stays at its call site.
 */
export function isSystemContextGraphExcludedFromChangelogLane(contextGraphId: string): boolean {
  return CHANGELOG_LANE_EXCLUDED_SYSTEM_CONTEXT_GRAPHS.includes(contextGraphId);
}
