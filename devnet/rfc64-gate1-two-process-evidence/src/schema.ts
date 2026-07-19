import { isNonEmptyString, isSafeNonNegativeInteger, isSha256Hex } from './canonical.ts';

export const RAW_SCHEMA_ID = 'rfc64-gate1-two-process-evidence/raw@1' as const;
export const VERDICT_SCHEMA_ID = 'rfc64-gate1-two-process-evidence/verdict@1' as const;

// This contract is a closed evidence contract. It is NOT wired to any product
// runtime and it never spawns, drives, or observes a real node — it defines and
// validates the SHAPE and INTERNAL CONSISTENCY of two-process Gate-1 evidence.
// These two markers are always present, on every raw artifact and every verdict,
// and are set from these constants by the verifier itself (never trusted from
// input) so a green fixture can never be read as a real Gate-1 pass.
export const PRODUCT_BOUNDARY = 'not-connected' as const;
export const GATE_EVALUATION = 'not-evaluated' as const;

/**
 * Canonical deterministic UAL shape, mirroring the production grammar
 * (`packages/core/src/ka-content-scope.ts` DETERMINISTIC_KA_UAL_RE and
 * `packages/agent/src/sync/responder/graph-plan.ts`), tightened to the
 * canonical form: lowercase network + address hex, and a tokenId with no
 * leading zeros.
 */
const CANONICAL_UAL =
  /^did:dkg:[a-z0-9](?:[a-z0-9.:_-]*[a-z0-9])?\/0x[0-9a-f]{40}\/(?:0|[1-9][0-9]*)$/;

export function isCanonicalUal(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UAL.test(value);
}

/** One RDF quad. All four terms are opaque non-empty strings to this contract. */
export type QuadV1 = {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph: string;
};

/** What the producer process authored and committed. */
export type ProducerRecordV1 = {
  readonly peerId: string;
  readonly ual: string;
  /** Canonically ordered, duplicate-free quad set. */
  readonly quads: readonly QuadV1[];
  /** Declared count — must equal `quads.length` exactly; never trusted. */
  readonly quadCount: number;
  readonly contentDigest: string;
  readonly bundleDigest: string;
  readonly bundleLength: number;
  readonly rowDigest: string;
  readonly headSequence: number;
  readonly previousHeadDigest: string;
  readonly headDigest: string;
};

/** What the receiver process reports after applying the producer's row. */
export type AppliedInventoryReadbackV1 = {
  readonly headSequence: number;
  readonly headDigest: string;
  readonly rowDigest: string;
  readonly bundleDigest: string;
  readonly contentDigest: string;
  readonly ual: string;
  readonly quadCount: number;
  readonly appliedRowCount: number;
};

/**
 * A forged-author submission the receiver must reject with EXACTLY ZERO
 * activation: no row activated, no bundle staged, applied head unmoved.
 */
export type ForgedAuthorAttemptV1 = {
  readonly forgedAuthorPeerId: string;
  readonly activatedRowCount: number;
  readonly stagedBundleCount: number;
  readonly appliedHeadDigestBefore: string;
  readonly appliedHeadDigestAfter: string;
  readonly rejectionCode: string;
};

/**
 * Receiver restart: the applied head must be recovered identically, with no
 * double-apply and no quad loss or duplication.
 */
export type RestartRepairV1 = {
  readonly appliedHeadDigestBeforeRestart: string;
  readonly appliedHeadDigestAfterRestart: string;
  readonly appliedRowCountBeforeRestart: number;
  readonly appliedRowCountAfterRestart: number;
  readonly quadCountAfterRestart: number;
  readonly repairPerformed: boolean;
};

export type ReceiverRecordV1 = {
  readonly peerId: string;
  readonly appliedInventory: AppliedInventoryReadbackV1;
  readonly forgedAuthorAttempt: ForgedAuthorAttemptV1;
  readonly restartRepair: RestartRepairV1;
};

export type RawEvidenceV1 = {
  readonly schema: typeof RAW_SCHEMA_ID;
  readonly productBoundary: typeof PRODUCT_BOUNDARY;
  readonly gateEvaluation: typeof GATE_EVALUATION;
  readonly producer: ProducerRecordV1;
  readonly receiver: ReceiverRecordV1;
};

/**
 * The closed check list. Each key maps to exactly one material invariant and
 * each has a dedicated mutation test. The seven evidence dimensions required by
 * the task map onto these keys as:
 *   peer IDs .................. peerIdsPresent, peerIdsDistinct,
 *                               forgedAuthorPeerDistinct
 *   head/row/bundle/content ... contentDigestMatches, bundleDigestMatches,
 *     digests                   rowDigestMatches, headDigestMatches
 *   UAL ....................... ualCanonical
 *   exact quad/count .......... quadsCanonicalOrder, quadsUnique,
 *                               quadCountExact
 *   applied inventory readback  appliedInventoryMatchesProducer,
 *                               appliedRowCountExact
 *   forged-author zero-activation
 *                               forgedAuthorZeroActivation,
 *                               forgedAuthorHeadUnchanged
 *   restart repair ............ restartHeadStable, restartNoDoubleApply,
 *                               restartQuadCountStable
 */
export type Gate1ChecksV1 = {
  readonly schemaWellFormed: boolean;
  readonly peerIdsPresent: boolean;
  readonly peerIdsDistinct: boolean;
  readonly ualCanonical: boolean;
  readonly quadsCanonicalOrder: boolean;
  readonly quadsUnique: boolean;
  readonly quadCountExact: boolean;
  readonly contentDigestMatches: boolean;
  readonly bundleDigestMatches: boolean;
  readonly rowDigestMatches: boolean;
  readonly headDigestMatches: boolean;
  readonly appliedInventoryMatchesProducer: boolean;
  readonly appliedRowCountExact: boolean;
  readonly forgedAuthorPeerDistinct: boolean;
  readonly forgedAuthorZeroActivation: boolean;
  readonly forgedAuthorHeadUnchanged: boolean;
  readonly restartHeadStable: boolean;
  readonly restartNoDoubleApply: boolean;
  readonly restartQuadCountStable: boolean;
};

export const GATE1_CHECK_KEYS: readonly (keyof Gate1ChecksV1)[] = Object.freeze([
  'schemaWellFormed',
  'peerIdsPresent',
  'peerIdsDistinct',
  'ualCanonical',
  'quadsCanonicalOrder',
  'quadsUnique',
  'quadCountExact',
  'contentDigestMatches',
  'bundleDigestMatches',
  'rowDigestMatches',
  'headDigestMatches',
  'appliedInventoryMatchesProducer',
  'appliedRowCountExact',
  'forgedAuthorPeerDistinct',
  'forgedAuthorZeroActivation',
  'forgedAuthorHeadUnchanged',
  'restartHeadStable',
  'restartNoDoubleApply',
  'restartQuadCountStable',
] as const);

export type RecomputedDigestsV1 = {
  readonly contentDigest: string;
  readonly bundleDigest: string;
  readonly rowDigest: string;
  readonly headDigest: string;
};

export type VerdictV1 = {
  readonly schema: typeof VERDICT_SCHEMA_ID;
  readonly productBoundary: typeof PRODUCT_BOUNDARY;
  readonly gateEvaluation: typeof GATE_EVALUATION;
  /**
   * True only when every invariant holds for this fixture. This is a
   * FIXTURE-level property, deliberately distinct from any gate disposition:
   * `gateEvaluation` stays `not-evaluated` regardless of this value.
   */
  readonly fixtureConsistent: boolean;
  readonly checks: Gate1ChecksV1;
  /** Digests recomputed from the evidence; declared fields are never trusted. */
  readonly recomputed: RecomputedDigestsV1;
  readonly rejectReasons: readonly string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const QUAD_KEYS = ['graph', 'object', 'predicate', 'subject'];
const PRODUCER_KEYS = [
  'bundleDigest',
  'bundleLength',
  'contentDigest',
  'headDigest',
  'headSequence',
  'peerId',
  'previousHeadDigest',
  'quadCount',
  'quads',
  'rowDigest',
  'ual',
];
const APPLIED_KEYS = [
  'appliedRowCount',
  'bundleDigest',
  'contentDigest',
  'headDigest',
  'headSequence',
  'quadCount',
  'rowDigest',
  'ual',
];
const FORGED_KEYS = [
  'activatedRowCount',
  'appliedHeadDigestAfter',
  'appliedHeadDigestBefore',
  'forgedAuthorPeerId',
  'rejectionCode',
  'stagedBundleCount',
];
const RESTART_KEYS = [
  'appliedHeadDigestAfterRestart',
  'appliedHeadDigestBeforeRestart',
  'appliedRowCountAfterRestart',
  'appliedRowCountBeforeRestart',
  'quadCountAfterRestart',
  'repairPerformed',
];
const RECEIVER_KEYS = ['appliedInventory', 'forgedAuthorAttempt', 'peerId', 'restartRepair'];
const RAW_KEYS = ['gateEvaluation', 'producer', 'productBoundary', 'receiver', 'schema'];

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseQuad(value: unknown): QuadV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, QUAD_KEYS)) return undefined;
  const { subject, predicate, object, graph } = value;
  if (
    !isNonEmptyString(subject) ||
    !isNonEmptyString(predicate) ||
    !isNonEmptyString(object) ||
    !isNonEmptyString(graph)
  ) {
    return undefined;
  }
  return Object.freeze({ subject, predicate, object, graph });
}

function parseQuadArray(value: unknown): readonly QuadV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const quads: QuadV1[] = [];
  for (const entry of value) {
    const quad = parseQuad(entry);
    if (quad === undefined) return undefined;
    quads.push(quad);
  }
  return Object.freeze(quads);
}

function parseProducer(value: unknown): ProducerRecordV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, PRODUCER_KEYS)) return undefined;
  const quads = parseQuadArray(value.quads);
  if (quads === undefined) return undefined;
  if (!isNonEmptyString(value.peerId) || !isNonEmptyString(value.ual)) return undefined;
  if (!isSafeNonNegativeInteger(value.quadCount)) return undefined;
  if (!isSafeNonNegativeInteger(value.bundleLength)) return undefined;
  if (!isSafeNonNegativeInteger(value.headSequence)) return undefined;
  if (
    !isSha256Hex(value.contentDigest) ||
    !isSha256Hex(value.bundleDigest) ||
    !isSha256Hex(value.rowDigest) ||
    !isSha256Hex(value.headDigest) ||
    !isSha256Hex(value.previousHeadDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    peerId: value.peerId,
    ual: value.ual,
    quads,
    quadCount: value.quadCount,
    contentDigest: value.contentDigest,
    bundleDigest: value.bundleDigest,
    bundleLength: value.bundleLength,
    rowDigest: value.rowDigest,
    headSequence: value.headSequence,
    previousHeadDigest: value.previousHeadDigest,
    headDigest: value.headDigest,
  });
}

function parseApplied(value: unknown): AppliedInventoryReadbackV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, APPLIED_KEYS)) return undefined;
  if (!isNonEmptyString(value.ual)) return undefined;
  if (
    !isSafeNonNegativeInteger(value.headSequence) ||
    !isSafeNonNegativeInteger(value.quadCount) ||
    !isSafeNonNegativeInteger(value.appliedRowCount)
  ) {
    return undefined;
  }
  if (
    !isSha256Hex(value.headDigest) ||
    !isSha256Hex(value.rowDigest) ||
    !isSha256Hex(value.bundleDigest) ||
    !isSha256Hex(value.contentDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    headSequence: value.headSequence,
    headDigest: value.headDigest,
    rowDigest: value.rowDigest,
    bundleDigest: value.bundleDigest,
    contentDigest: value.contentDigest,
    ual: value.ual,
    quadCount: value.quadCount,
    appliedRowCount: value.appliedRowCount,
  });
}

function parseForged(value: unknown): ForgedAuthorAttemptV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, FORGED_KEYS)) return undefined;
  if (!isNonEmptyString(value.forgedAuthorPeerId) || !isNonEmptyString(value.rejectionCode)) {
    return undefined;
  }
  if (
    !isSafeNonNegativeInteger(value.activatedRowCount) ||
    !isSafeNonNegativeInteger(value.stagedBundleCount)
  ) {
    return undefined;
  }
  if (!isSha256Hex(value.appliedHeadDigestBefore) || !isSha256Hex(value.appliedHeadDigestAfter)) {
    return undefined;
  }
  return Object.freeze({
    forgedAuthorPeerId: value.forgedAuthorPeerId,
    activatedRowCount: value.activatedRowCount,
    stagedBundleCount: value.stagedBundleCount,
    appliedHeadDigestBefore: value.appliedHeadDigestBefore,
    appliedHeadDigestAfter: value.appliedHeadDigestAfter,
    rejectionCode: value.rejectionCode,
  });
}

function parseRestart(value: unknown): RestartRepairV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, RESTART_KEYS)) return undefined;
  if (typeof value.repairPerformed !== 'boolean') return undefined;
  if (
    !isSafeNonNegativeInteger(value.appliedRowCountBeforeRestart) ||
    !isSafeNonNegativeInteger(value.appliedRowCountAfterRestart) ||
    !isSafeNonNegativeInteger(value.quadCountAfterRestart)
  ) {
    return undefined;
  }
  if (
    !isSha256Hex(value.appliedHeadDigestBeforeRestart) ||
    !isSha256Hex(value.appliedHeadDigestAfterRestart)
  ) {
    return undefined;
  }
  return Object.freeze({
    appliedHeadDigestBeforeRestart: value.appliedHeadDigestBeforeRestart,
    appliedHeadDigestAfterRestart: value.appliedHeadDigestAfterRestart,
    appliedRowCountBeforeRestart: value.appliedRowCountBeforeRestart,
    appliedRowCountAfterRestart: value.appliedRowCountAfterRestart,
    quadCountAfterRestart: value.quadCountAfterRestart,
    repairPerformed: value.repairPerformed,
  });
}

function parseReceiver(value: unknown): ReceiverRecordV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, RECEIVER_KEYS)) return undefined;
  if (!isNonEmptyString(value.peerId)) return undefined;
  const appliedInventory = parseApplied(value.appliedInventory);
  const forgedAuthorAttempt = parseForged(value.forgedAuthorAttempt);
  const restartRepair = parseRestart(value.restartRepair);
  if (
    appliedInventory === undefined ||
    forgedAuthorAttempt === undefined ||
    restartRepair === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    peerId: value.peerId,
    appliedInventory,
    forgedAuthorAttempt,
    restartRepair,
  });
}

/**
 * Fail-closed structural parse of raw evidence. Returns `undefined` for any
 * shape deviation — unknown or missing keys, wrong types, malformed hex,
 * non-integer counts, or the wrong schema/boundary literals — so the verifier
 * can record a schema rejection rather than trusting or throwing on bad input.
 */
export function parseRawEvidence(value: unknown): RawEvidenceV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, RAW_KEYS)) return undefined;
  if (value.schema !== RAW_SCHEMA_ID) return undefined;
  if (value.productBoundary !== PRODUCT_BOUNDARY) return undefined;
  if (value.gateEvaluation !== GATE_EVALUATION) return undefined;
  const producer = parseProducer(value.producer);
  const receiver = parseReceiver(value.receiver);
  if (producer === undefined || receiver === undefined) return undefined;
  return Object.freeze({
    schema: RAW_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    producer,
    receiver,
  });
}
