import { canonicalize, UTF8 } from './canonical.ts';
import {
  GENESIS_HEAD_DIGEST,
  compareQuads,
  computeBundleDigest,
  computeContentDigest,
  computeHeadDigest,
  computeRowDigest,
} from './digests.ts';
import {
  GATE_EVALUATION,
  PRODUCT_BOUNDARY,
  RAW_SCHEMA_ID,
  type QuadV1,
  type RawEvidenceV1,
} from './schema.ts';

// Fixed, deterministic identities. No clock, no randomness, no host input:
// generate(n) is a pure function of n.
const PRODUCER_PEER_ID = 'QmGate1ProducerPeer00000000000000000000000001';
const RECEIVER_PEER_ID = 'QmGate1ReceiverPeer00000000000000000000000002';
const FORGED_PEER_ID = 'QmGate1ForgedAuthorPeer000000000000000000000003';
const CONTEXT_GRAPH = 'did:dkg:base:8453/0x1111111111111111111111111111111111111111/1';
const UAL = 'did:dkg:base:8453/0x2222222222222222222222222222222222222222/42';
const REJECTION_CODE = 'catalog-native-receiver-author-attestation';

/** Deterministic quad set for `count` triples, then canonically sorted. */
function buildQuads(count: number): readonly QuadV1[] {
  const quads: QuadV1[] = [];
  for (let index = 0; index < count; index += 1) {
    quads.push({
      subject: `${UAL}#entity-${index}`,
      predicate: 'https://ontology.origintrail.io/dkg/1.0#hasOrdinal',
      object: `"${index}"^^http://www.w3.org/2001/XMLSchema#integer`,
      graph: CONTEXT_GRAPH,
    });
  }
  return Object.freeze([...quads].sort(compareQuads));
}

/**
 * Build a fully consistent two-process evidence artifact for `quadCount` quads.
 * Pure function of the argument: identical input yields byte-identical output.
 */
export function generateConsistentEvidence(quadCount: number): RawEvidenceV1 {
  if (!Number.isSafeInteger(quadCount) || quadCount < 1) {
    throw new RangeError(`quadCount must be a safe integer >= 1, got ${String(quadCount)}`);
  }
  const quads = buildQuads(quadCount);
  const contentDigest = computeContentDigest(quads);
  // The bundle length is the exact byte length of the canonical quad-set
  // serialization — derived, never invented.
  const bundleLength = UTF8.encode(canonicalize(quads)).length;
  const bundleDigest = computeBundleDigest(contentDigest, bundleLength);
  const rowDigest = computeRowDigest({
    ual: UAL,
    contentDigest,
    bundleDigest,
    bundleLength,
    quadCount: quads.length,
  });
  const headSequence = 1;
  const headDigest = computeHeadDigest({
    previousHeadDigest: GENESIS_HEAD_DIGEST,
    rowDigest,
    headSequence,
  });

  return Object.freeze({
    schema: RAW_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    producer: Object.freeze({
      peerId: PRODUCER_PEER_ID,
      ual: UAL,
      quads,
      quadCount: quads.length,
      contentDigest,
      bundleDigest,
      bundleLength,
      rowDigest,
      headSequence,
      previousHeadDigest: GENESIS_HEAD_DIGEST,
      headDigest,
    }),
    receiver: Object.freeze({
      peerId: RECEIVER_PEER_ID,
      appliedInventory: Object.freeze({
        headSequence,
        headDigest,
        rowDigest,
        bundleDigest,
        contentDigest,
        ual: UAL,
        quadCount: quads.length,
        appliedRowCount: 1,
      }),
      forgedAuthorAttempt: Object.freeze({
        forgedAuthorPeerId: FORGED_PEER_ID,
        activatedRowCount: 0,
        stagedBundleCount: 0,
        appliedHeadDigestBefore: headDigest,
        appliedHeadDigestAfter: headDigest,
        rejectionCode: REJECTION_CODE,
      }),
      restartRepair: Object.freeze({
        appliedHeadDigestBeforeRestart: headDigest,
        appliedHeadDigestAfterRestart: headDigest,
        appliedRowCountBeforeRestart: 1,
        appliedRowCountAfterRestart: 1,
        quadCountAfterRestart: quads.length,
        repairPerformed: true,
      }),
    }),
  });
}
