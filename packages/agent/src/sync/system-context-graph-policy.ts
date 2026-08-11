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

type SystemContextGraphId = (typeof SYSTEM_CONTEXT_GRAPHS)[keyof typeof SYSTEM_CONTEXT_GRAPHS];

/**
 * What a system Context Graph does at the durable-sync lane fork.
 *
 * The two states are NOT "excluded" and "included" — they are "decided" and
 * "not decided". Collapsing the second into a boolean `false` is exactly the
 * loss this type exists to prevent, because it makes an unanswered question
 * indistinguishable from an answered one.
 */
export type ChangelogLaneDisposition =
  /** DECIDED: rides the legacy durable lane, never the changelog lane. */
  | 'excluded-rides-legacy'
  /**
   * NOT DECIDED. The graph currently reaches the changelog lane because nothing
   * excludes it — the absence of a decision, not a decision to allow it. Do not
   * cite this value as clearance.
   */
  | 'undecided-rides-changelog-lane';

/**
 * Lane disposition for EVERY system Context Graph.
 *
 * The `satisfies Record<SystemContextGraphId, ...>` is the enforcement, and it
 * is the point of this table rather than a decoration: adding a member to
 * `SYSTEM_CONTEXT_GRAPHS` makes this object stop satisfying the constraint and
 * FAILS THE BUILD until someone states that graph's lane disposition. Verified
 * by construction — a third member was added experimentally and `tsc` rejected
 * this table until it was given a value.
 *
 * That matters because the sibling policy cannot ask the same question: the
 * verification-posture check (`acceptUnverified`) keys on membership of the
 * WHOLE set via `Object.values(SYSTEM_CONTEXT_GRAPHS).includes(...)`, so it
 * absorbs a new member SILENTLY and grants it the merkle bypass with nobody
 * deciding anything. This table cannot close that gap on the verification side;
 * it closes it on the lane side and makes the omission loud.
 */
const CHANGELOG_LANE_DISPOSITIONS = {
  [SYSTEM_CONTEXT_GRAPHS.AGENTS]: 'excluded-rides-legacy',
  [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]: 'undecided-rides-changelog-lane',
} as const satisfies Record<SystemContextGraphId, ChangelogLaneDisposition>;

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
 * RESIDUAL DRIFT, now HALF closed rather than merely documented. Lane
 * disposition (this table) and verification posture (`acceptUnverified`) are
 * related policies maintained in separate places and keyed differently: this
 * table is EXHAUSTIVE over the system graphs and fails the build when a member
 * is added, whereas `acceptUnverified` keys on membership of the whole set and
 * therefore absorbs a new member silently. So a graph added tomorrow can no
 * longer slip past the LANE decision, but it still receives the merkle bypass
 * with nobody deciding. Closing that second half is not this module's to do.
 *
 * Pure by construction: no store reads, no async. The private-graph divert is a
 * separate, asynchronous decision and stays at its call site.
 */
export function isSystemContextGraphExcludedFromChangelogLane(contextGraphId: string): boolean {
  const disposition: ChangelogLaneDisposition | undefined =
    (CHANGELOG_LANE_DISPOSITIONS as Record<string, ChangelogLaneDisposition>)[contextGraphId];
  return disposition === 'excluded-rides-legacy';
}
