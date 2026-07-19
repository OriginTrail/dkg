import {
  computeBundleDigest,
  computeContentDigest,
  computeHeadDigest,
  computeRowDigest,
  compareQuads,
  canonicalQuad,
} from './digests.ts';
import {
  GATE_EVALUATION,
  GATE1_CHECK_KEYS,
  PRODUCT_BOUNDARY,
  VERDICT_SCHEMA_ID,
  isCanonicalUal,
  parseRawEvidence,
  type Gate1ChecksV1,
  type RawEvidenceV1,
  type RecomputedDigestsV1,
  type VerdictV1,
} from './schema.ts';

const UNKNOWN_DIGEST = '0'.repeat(64);

const ALL_FALSE_CHECKS: Gate1ChecksV1 = Object.freeze(
  Object.fromEntries(GATE1_CHECK_KEYS.map((key) => [key, false])),
) as Gate1ChecksV1;

function verdict(
  checks: Gate1ChecksV1,
  recomputed: RecomputedDigestsV1,
  rejectReasons: readonly string[],
): VerdictV1 {
  // fixtureConsistent is derived from the closed key list, never from a
  // hand-maintained conjunction that could drift as checks are added.
  const fixtureConsistent = GATE1_CHECK_KEYS.every((key) => checks[key]);
  return Object.freeze({
    // The boundary markers are stamped from the constants here, never copied
    // from input, so a doctored artifact cannot relabel itself as a real pass.
    schema: VERDICT_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    fixtureConsistent,
    checks: Object.freeze({ ...checks }),
    recomputed: Object.freeze({ ...recomputed }),
    rejectReasons: Object.freeze([...rejectReasons]),
  });
}

/**
 * Fail-closed verifier over two-process Gate-1 evidence. It ALWAYS returns a
 * verdict and never throws on bad input. Every digest is recomputed from the
 * evidence and compared to the declared field; no declared digest, root, or
 * count is ever trusted.
 *
 * `fixtureConsistent` is a fixture-level property only. `gateEvaluation` stays
 * `not-evaluated` unconditionally: this contract is not wired to a product
 * runtime, so a green verdict is never a real Gate-1 pass.
 */
export function verifyEvidence(input: unknown): VerdictV1 {
  const raw = parseRawEvidence(input);
  if (raw === undefined) {
    return verdict(
      ALL_FALSE_CHECKS,
      {
        contentDigest: UNKNOWN_DIGEST,
        bundleDigest: UNKNOWN_DIGEST,
        rowDigest: UNKNOWN_DIGEST,
        headDigest: UNKNOWN_DIGEST,
      },
      ['schema: raw evidence failed structural parse'],
    );
  }
  return verifyParsed(raw);
}

function verifyParsed(raw: RawEvidenceV1): VerdictV1 {
  const { producer, receiver } = raw;
  const applied = receiver.appliedInventory;
  const forged = receiver.forgedAuthorAttempt;
  const restart = receiver.restartRepair;
  const reasons: string[] = [];

  // --- peer identity: two DISTINCT processes ------------------------------
  const peerIdsPresent = producer.peerId.length > 0 && receiver.peerId.length > 0;
  const peerIdsDistinct = peerIdsPresent && producer.peerId !== receiver.peerId;
  if (!peerIdsDistinct) {
    reasons.push('peers: producer and receiver peer ids must both be present and distinct');
  }

  // --- identity ------------------------------------------------------------
  const ualCanonical = isCanonicalUal(producer.ual);
  if (!ualCanonical) reasons.push(`ual: "${producer.ual}" is not a canonical deterministic UAL`);

  // --- exact quad set and count -------------------------------------------
  const canonicalForms = producer.quads.map(canonicalQuad);
  const quadsCanonicalOrder = producer.quads.every(
    (quad, index) => index === 0 || compareQuads(producer.quads[index - 1]!, quad) <= 0,
  );
  if (!quadsCanonicalOrder) reasons.push('quads: array is not in canonical ascending order');

  // Duplicate detection runs on the RAW array, before any Set collapse.
  const quadsUnique = new Set(canonicalForms).size === canonicalForms.length;
  if (!quadsUnique) reasons.push('quads: array contains duplicate quads');

  const quadCountExact = producer.quadCount === producer.quads.length;
  if (!quadCountExact) {
    reasons.push(
      `quadCount: declared ${producer.quadCount} but the array holds ${producer.quads.length}`,
    );
  }

  // --- digest chain, entirely recomputed ----------------------------------
  const contentDigest = computeContentDigest(producer.quads);
  const bundleDigest = computeBundleDigest(contentDigest, producer.bundleLength);
  const rowDigest = computeRowDigest({
    ual: producer.ual,
    contentDigest,
    bundleDigest,
    bundleLength: producer.bundleLength,
    quadCount: producer.quads.length,
  });
  const headDigest = computeHeadDigest({
    previousHeadDigest: producer.previousHeadDigest,
    rowDigest,
    headSequence: producer.headSequence,
  });
  const recomputed: RecomputedDigestsV1 = { contentDigest, bundleDigest, rowDigest, headDigest };

  const contentDigestMatches = producer.contentDigest === contentDigest;
  if (!contentDigestMatches) reasons.push('contentDigest: declared value does not match recomputed');
  const bundleDigestMatches = producer.bundleDigest === bundleDigest;
  if (!bundleDigestMatches) reasons.push('bundleDigest: declared value does not match recomputed');
  const rowDigestMatches = producer.rowDigest === rowDigest;
  if (!rowDigestMatches) reasons.push('rowDigest: declared value does not match recomputed');
  const headDigestMatches = producer.headDigest === headDigest;
  if (!headDigestMatches) reasons.push('headDigest: declared value does not match recomputed');

  // --- applied inventory readback: cross-peer agreement -------------------
  // Compared against the RECOMPUTED digests, so a receiver that agrees with a
  // forged producer field is still rejected.
  const appliedMismatches: string[] = [];
  if (applied.headSequence !== producer.headSequence) appliedMismatches.push('headSequence');
  if (applied.headDigest !== headDigest) appliedMismatches.push('headDigest');
  if (applied.rowDigest !== rowDigest) appliedMismatches.push('rowDigest');
  if (applied.bundleDigest !== bundleDigest) appliedMismatches.push('bundleDigest');
  if (applied.contentDigest !== contentDigest) appliedMismatches.push('contentDigest');
  if (applied.ual !== producer.ual) appliedMismatches.push('ual');
  if (applied.quadCount !== producer.quads.length) appliedMismatches.push('quadCount');
  const appliedInventoryMatchesProducer = appliedMismatches.length === 0;
  if (!appliedInventoryMatchesProducer) {
    reasons.push(
      `appliedInventory: receiver readback disagrees with the recomputed producer state on ${appliedMismatches.join(', ')}`,
    );
  }

  // Exactly one row was produced, so exactly one row must be applied.
  const appliedRowCountExact = applied.appliedRowCount === 1;
  if (!appliedRowCountExact) {
    reasons.push(`appliedInventory: appliedRowCount must be exactly 1, got ${applied.appliedRowCount}`);
  }

  // --- forged author: EXACT zero activation -------------------------------
  const forgedAuthorPeerDistinct =
    forged.forgedAuthorPeerId !== producer.peerId && forged.forgedAuthorPeerId !== receiver.peerId;
  if (!forgedAuthorPeerDistinct) {
    reasons.push('forgedAuthor: forged peer id must differ from both the producer and the receiver');
  }

  const forgedAuthorZeroActivation =
    forged.activatedRowCount === 0 && forged.stagedBundleCount === 0 && forged.rejectionCode.length > 0;
  if (!forgedAuthorZeroActivation) {
    reasons.push(
      `forgedAuthor: expected exact zero activation with a rejection code, got activatedRowCount=${forged.activatedRowCount} stagedBundleCount=${forged.stagedBundleCount} rejectionCode="${forged.rejectionCode}"`,
    );
  }

  // The head must be unmoved AND must still be the legitimately applied head:
  // pinning both endpoints to the recomputed head stops a fixture from
  // "holding steady" at some other value.
  const forgedAuthorHeadUnchanged =
    forged.appliedHeadDigestBefore === forged.appliedHeadDigestAfter &&
    forged.appliedHeadDigestBefore === headDigest;
  if (!forgedAuthorHeadUnchanged) {
    reasons.push('forgedAuthor: applied head moved, or did not remain the recomputed applied head');
  }

  // --- restart repair: idempotent recovery to the same head ---------------
  const restartHeadStable =
    restart.appliedHeadDigestBeforeRestart === restart.appliedHeadDigestAfterRestart &&
    restart.appliedHeadDigestAfterRestart === headDigest;
  if (!restartHeadStable) {
    reasons.push('restart: applied head did not recover identically to the recomputed applied head');
  }

  const restartNoDoubleApply =
    restart.appliedRowCountAfterRestart === restart.appliedRowCountBeforeRestart &&
    restart.appliedRowCountAfterRestart === applied.appliedRowCount;
  if (!restartNoDoubleApply) {
    reasons.push(
      `restart: applied row count changed across restart (${restart.appliedRowCountBeforeRestart} -> ${restart.appliedRowCountAfterRestart}, readback ${applied.appliedRowCount})`,
    );
  }

  const restartQuadCountStable = restart.quadCountAfterRestart === producer.quads.length;
  if (!restartQuadCountStable) {
    reasons.push(
      `restart: quad count after restart is ${restart.quadCountAfterRestart}, expected ${producer.quads.length}`,
    );
  }

  const checks: Gate1ChecksV1 = {
    schemaWellFormed: true,
    peerIdsPresent,
    peerIdsDistinct,
    ualCanonical,
    quadsCanonicalOrder,
    quadsUnique,
    quadCountExact,
    contentDigestMatches,
    bundleDigestMatches,
    rowDigestMatches,
    headDigestMatches,
    appliedInventoryMatchesProducer,
    appliedRowCountExact,
    forgedAuthorPeerDistinct,
    forgedAuthorZeroActivation,
    forgedAuthorHeadUnchanged,
    restartHeadStable,
    restartNoDoubleApply,
    restartQuadCountStable,
  };

  return verdict(checks, recomputed, reasons);
}
