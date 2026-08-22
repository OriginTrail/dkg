import {
  assertAgentProfileHeadObjectV1,
  computeAgentProfileHeadObjectDigestV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  type AgentProfileHeadObjectV1,
  type AgentProfileTombstoneHeadObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

/**
 * ONE tombstone-head builder for both seam suites.
 *
 * It was two, and the second copy was written by copying the first. Two copies
 * of a fixture prove that they agree, never that either is right, and this one
 * encodes several codec rules that a head-codec change would move: which
 * active-only fields must be deleted, which projection counters must be zeroed,
 * and that the result has to be re-validated rather than trusted. A drift here
 * would not fail loudly -- one suite would keep building a shape the codec no
 * longer accepts and report it as a domain refusal.
 *
 * THE VERSION IS A PARAMETER, AND THAT IS AN UNLOCK RATHER THAN A CONVENIENCE.
 * `isTombstoneBoundToPredecessorV1` requires the tombstone's version to be
 * STRICTLY GREATER than its predecessor's -- not adjacent. A builder hard-coding
 * `predecessor.version + 1` reaches exactly one version relation against any
 * given applied row and makes the other two look unconstructible; two seats lost
 * a wall to that before it was parameterized. Minting off a version-zero
 * ancestry head instead makes every relation available.
 *
 * `overrides` exists for the conjunct enumeration that proves an unbound
 * tombstone cannot be constructed through the real entry: each binding conjunct
 * is perturbed in turn, and where the codec refuses the shape outright that
 * refusal IS the measurement.
 */
export function buildTombstoneHeadFromPredecessorV1(
  predecessor: AgentProfileHeadObjectV1,
  version?: string,
  overrides: Record<string, unknown> = {},
): AgentProfileTombstoneHeadObjectV1 {
  const shaped: Record<string, unknown> = {
    ...structuredClone(predecessor),
    state: 'tombstone',
    version: version ?? String(BigInt((predecessor as { version: string }).version) + 1n),
    previousHeadDigest: computeAgentProfileHeadObjectDigestV1(predecessor),
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
    ...overrides,
  };
  // A tombstone commits none of the active head's projection or seal fields,
  // and the head codec refuses the shape if any of them survives.
  for (const key of [
    'contentDigest', 'bundleDigest', 'graphScopedAuthorSeal', 'validUntil',
    'assertionCoordinate',
  ]) {
    delete shaped[key];
  }
  const built = Object.freeze(shaped) as unknown as AgentProfileHeadObjectV1;
  assertAgentProfileHeadObjectV1(built);
  if (built.state !== 'tombstone') {
    throw new Error(`fixture built a ${built.state} head where a tombstone was required`);
  }
  return built;
}
