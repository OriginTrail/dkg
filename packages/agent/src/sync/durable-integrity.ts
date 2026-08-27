import { createHash } from 'node:crypto';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  parseGraphScopedAssertionSealCandidate,
  knowledgeAssetLayerGraphUri,
  parseDeterministicKnowledgeAssetUal,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10 as computeStructuredKCRoot,
  skolemizeByEntity,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { appendInPlace } from './append-in-place.js';
import { isIriMetaSubject } from './iri-term.js';

const DKG_NS = 'http://dkg.io/ontology/';
const MERKLE_ROOT = `${DKG_NS}merkleRoot`;
const CONTENT_SCOPE_VERSION = `${DKG_NS}contentScopeVersion`;
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_VERSION = `${DKG_NS}assertionVersion`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;
const CONTEXT_GRAPH = `${DKG_NS}contextGraph`;
const BATCH_ID = `${DKG_NS}batchId`;
const STATUS = `${DKG_NS}status`;
const RESERVED_UAL = `${DKG_NS}reservedUal`;
const PUBLIC_TRIPLE_COUNT = `${DKG_NS}publicTripleCount`;
const PRIVATE_TRIPLE_COUNT = `${DKG_NS}privateTripleCount`;
const PRIVATE_MERKLE_ROOT = `${DKG_NS}privateMerkleRoot`;
const SUB_GRAPH_NAME = `${DKG_NS}subGraphName`;
const ROOT_ENTITY = `${DKG_NS}rootEntity`;
const PART_OF = `${DKG_NS}partOf`;
const SKOLEM_SUFFIX = '/.well-known/genid/';

/**
 * Predicates that make a durable metadata record part of a KA integrity
 * envelope. Keep this list beside the verifier that interprets the envelope:
 * changelog cursor planning must fail closed when any one of these fields is
 * present, even when a malformed record is missing its Merkle root.
 */
export const DURABLE_INTEGRITY_META_PREDICATES = [
  MERKLE_ROOT,
  CONTENT_SCOPE_VERSION,
  KA_UAL,
  ASSERTION_VERSION,
  ASSERTION_GRAPH,
  PUBLIC_TRIPLE_COUNT,
  PRIVATE_TRIPLE_COUNT,
  PRIVATE_MERKLE_ROOT,
] as const;

const DURABLE_INTEGRITY_META_PREDICATE_SET: ReadonlySet<string> = new Set(
  DURABLE_INTEGRITY_META_PREDICATES,
);

/**
 * Peer-supplied fields that drive durable delta selection or graph routing.
 * Unlike descriptive metadata, these controls are safe to persist only when
 * their subject belongs to an integrity envelope admitted by this batch.
 */
const DURABLE_SYNC_CONTROL_PREDICATE_SET: ReadonlySet<string> = new Set([
  BATCH_ID,
  ASSERTION_GRAPH,
  ASSERTION_VERSION,
]);

export interface DurableMetaGraphClassification {
  hasMerkleRoot: boolean;
  hasIntegrityEnvelope: boolean;
}

/** Classify a parsed durable metadata record using the verifier's predicates. */
export function classifyDurableMetaGraph(
  quads: readonly Quad[],
): DurableMetaGraphClassification {
  let hasMerkleRoot = false;
  let hasIntegrityEnvelope = false;
  for (const quad of quads) {
    if (quad.predicate === MERKLE_ROOT) hasMerkleRoot = true;
    if (
      DURABLE_INTEGRITY_META_PREDICATE_SET.has(quad.predicate)
      && (quad.predicate === MERKLE_ROOT || isDeterministicKaMetadataSubject(quad.subject))
    ) {
      hasIntegrityEnvelope = true;
    }
    if (hasMerkleRoot && hasIntegrityEnvelope) break;
  }
  return { hasMerkleRoot, hasIntegrityEnvelope };
}

export interface DurableIntegrityLogEntry {
  level: 'debug' | 'warn';
  message: string;
}

export type DurableIntegrityVerificationMode =
  | { kind: 'fullSnapshot' }
  | { kind: 'sinceBatchId'; sinceBatchId: bigint }
  | { kind: 'changelogPage'; changedDataGraphs: ReadonlySet<string> };

export interface DurableIntegritySelection {
  dataIndexes: number[];
  metaIndexes: number[];
  rejected: number;
  /** Unauthenticated cursor/routing rows deliberately consumed but not persisted (diagnostic). */
  droppedSyncControlTriples: number;
  /** Non-IRI (blank-node/literal) `_meta` subject rows dropped at peer ingest (#1921) (diagnostic). */
  droppedNonIriSubjectTriples: number;
  /**
   * Reason-agnostic aggregate of `_meta` rows deliberately consumed but NOT
   * persisted (= droppedSyncControlTriples + droppedNonIriSubjectTriples). Owned
   * here by the verifier that classifies the drops (#1921): the worker transports
   * it and the requester uses it as the single meta-checkpoint-advance signal, so
   * checkpoint policy never has to enumerate verifier discard reasons. The two
   * per-reason fields above stay as diagnostics.
   */
  consumedUnpersistedMetaTriples: number;
  /** Verified V2 assets whose exact public assertion graph is intentionally empty. */
  verifiedZeroPublicAssets: number;
  /** Exact assertion graphs whose V2 descriptors and fetched payload verified. */
  verifiedGraphScopedDataGraphs: string[];
  logs: DurableIntegrityLogEntry[];
}

/**
 * A safe, graph-aligned prefix from an incomplete rootless durable snapshot.
 *
 * Durable V2 responders order exact assertion graphs by Unicode code point and
 * concatenate each complete graph into one stable row stream. A requester may
 * therefore persist and checkpoint the leading *complete* graphs after a
 * deadline, while discarding the final partial graph. Legacy/root-scoped or
 * structurally-invalid metadata deliberately returns `null`: those layouts do
 * not provide a safe graph boundary and retain the existing all-or-nothing
 * verification behaviour.
 */
export interface BoundedGraphScopedDurableBatch {
  /** Only rows belonging to complete assertion graphs in this fetch round. */
  dataQuads: Quad[];
  /** Exact graphs whose descriptors are in scope for this verification round. */
  changedDataGraphs: string[];
  /** Absolute verified manifest offset at the last complete graph boundary. */
  safeNextOffset: number;
  /** Raw immutable responder-session cursor at that verified boundary. */
  safeRawNextOffset: number;
  /** Number of positive-size assertion graphs completed in this round. */
  completedGraphCount: number;
  /** Total public rows declared by the verified graph-scoped manifest. */
  manifestRowCount: number;
}

function compareUnicodeCodePoints(leftValue: string, rightValue: string): number {
  const left = Array.from(leftValue);
  const right = Array.from(rightValue);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const delta = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function digestGraphScopedMetadataRows(rows: readonly Quad[]): string {
  const hash = createHash('sha256');
  const encoder = new TextEncoder();
  const append = (value: string): void => {
    const bytes = encoder.encode(value);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  };
  const canonical = [...rows].sort((left, right) => (
    compareUnicodeCodePoints(left.subject, right.subject)
    || compareUnicodeCodePoints(left.predicate, right.predicate)
    || compareUnicodeCodePoints(left.object, right.object)
    || compareUnicodeCodePoints(left.graph, right.graph)
  ));
  append('origintrail.dkg.durable-graph-metadata');
  append('1');
  append(String(canonical.length));
  for (const row of canonical) {
    append(row.subject);
    append(row.predicate);
    append(row.object);
    append(row.graph);
  }
  return hash.digest('hex');
}

function readOrderedGraphScopedDescriptors(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
): GraphScopedDescriptor[] | null {
  // #1921 — verification must never see non-IRI `_meta` subjects: a peer's
  // `_:bad dkg:partOf "<valid-ual>"` row would otherwise be scanned by
  // readIntegrityMetadata and falsely invalidate that valid graph-scoped UAL.
  const iriMetaQuads = metaQuads.filter((quad) => isIriMetaSubject(quad.subject));
  const metadata = indexIntegrityMetadata(dataQuads, iriMetaQuads);
  const parsed = readIntegrityMetadata(metadata, false);
  if (
    parsed.fatalUnscopedFailure
    || parsed.invalidKcUals.size > 0
    || parsed.candidates.length === 0
    || parsed.candidates.some((candidate) => candidate.kind !== 'graph-scoped')
  ) return null;

  const descriptors = (parsed.candidates as GraphScopedCandidate[])
    .map((candidate) => candidate.descriptor)
    .sort((left, right) => compareUnicodeCodePoints(left.assertionGraph, right.assertionGraph));
  const descriptorByGraph = new Map(
    descriptors.map((descriptor) => [descriptor.assertionGraph, descriptor] as const),
  );
  return descriptorByGraph.size === descriptors.length ? descriptors : null;
}

export const DURABLE_MANIFEST_DIGEST_DOMAIN = 'origintrail.dkg.durable-data-manifest';
export const DURABLE_MANIFEST_DIGEST_VERSION = 2;
export const DURABLE_MANIFEST_PREFIX_DIGEST_DOMAIN = 'origintrail.dkg.durable-data-manifest-prefix';

export interface GraphScopedDurableManifestPlan {
  readonly contextGraphId: string;
  readonly manifestDigest: `sha256:${string}`;
  readonly descriptors: readonly GraphScopedDescriptor[];
  readonly manifestRowCount: number;
}

export interface GraphScopedDurableManifestPrefix {
  readonly offset: number;
  readonly descriptorCount: number;
  readonly prefixDigest: `sha256:${string}`;
}

/**
 * Encode the exact graph-scoped DATA plan without depending on RDF row order.
 *
 * Every scalar is length-prefixed independently. This makes embedded
 * separators and empty optional values unambiguous while the explicit domain
 * and version prevent the bytes from being reused as another protocol hash.
 */
export function encodeGraphScopedDurableManifest(
  contextGraphId: string,
  descriptors: readonly GraphScopedDescriptor[],
  domain = DURABLE_MANIFEST_DIGEST_DOMAIN,
  version = DURABLE_MANIFEST_DIGEST_VERSION,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const append = (value: string): void => {
    const bytes = encoder.encode(value);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.byteLength, false);
    chunks.push(length, bytes);
    byteLength += length.byteLength + bytes.byteLength;
  };

  append(domain);
  append(String(version));
  append(contextGraphId);
  append(String(descriptors.length));
  for (const descriptor of descriptors) {
    append(descriptor.ual);
    append(descriptor.contentScopeVersion);
    append(descriptor.assertionVersion);
    append(descriptor.contextGraphId);
    append(descriptor.subGraphName ?? '');
    append(descriptor.assertionGraph);
    append(String(descriptor.publicTripleCount));
    append(descriptor.claimedRootHex);
    append(String(descriptor.privateTripleCount));
    append(descriptor.privateRootHex ?? '');
    append(descriptor.metadataDigestHex);
  }

  const encoded = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoded;
}

/**
 * Parse, validate, order and bind the complete V2 manifest that defines a
 * rootless durable DATA plan. `null` means the metadata is incomplete,
 * malformed, mixed legacy/V2, or belongs to another Context Graph and cannot
 * authorize a nonzero continuation.
 */
export function createGraphScopedDurableManifestPlan(
  metaQuads: readonly Quad[],
  contextGraphId: string,
): GraphScopedDurableManifestPlan | null {
  const descriptors = readOrderedGraphScopedDescriptors([], metaQuads);
  if (
    !descriptors
    || descriptors.some((descriptor) => descriptor.contextGraphId !== contextGraphId)
  ) return null;

  let manifestRowCount = 0;
  for (const descriptor of descriptors) {
    manifestRowCount += descriptor.publicTripleCount;
    if (!Number.isSafeInteger(manifestRowCount)) return null;
  }
  const canonical = encodeGraphScopedDurableManifest(contextGraphId, descriptors);
  const manifestDigest = `sha256:${createHash('sha256').update(canonical).digest('hex')}` as const;
  return {
    contextGraphId,
    manifestDigest,
    descriptors,
    manifestRowCount,
  };
}

/**
 * Bind one verified DATA checkpoint boundary to the canonical descriptor
 * prefix that gives that offset meaning.
 *
 * Zero-width descriptors immediately following a positive-width graph are
 * included at that boundary. This makes inserting/removing a private-only or
 * empty asset before the next DATA row observable even though the numeric
 * offset does not move.
 */
export function graphScopedDurableManifestPrefixAtOffset(
  manifest: GraphScopedDurableManifestPlan,
  offset: number,
): GraphScopedDurableManifestPrefix | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;

  let rowCount = 0;
  let descriptorCount = 0;
  if (offset === 0) {
    while (
      descriptorCount < manifest.descriptors.length
      && manifest.descriptors[descriptorCount]!.publicTripleCount === 0
    ) {
      descriptorCount += 1;
    }
  }
  for (const descriptor of manifest.descriptors) {
    if (offset === 0) break;
    const nextRowCount = rowCount + descriptor.publicTripleCount;
    if (!Number.isSafeInteger(nextRowCount)) return null;
    if (nextRowCount > offset) return null;
    rowCount = nextRowCount;
    descriptorCount += 1;

    if (rowCount === offset) {
      while (
        descriptorCount < manifest.descriptors.length
        && manifest.descriptors[descriptorCount]!.publicTripleCount === 0
      ) {
        descriptorCount += 1;
      }
      break;
    }
  }

  if (rowCount !== offset) return null;
  const canonical = encodeGraphScopedDurableManifest(
    manifest.contextGraphId,
    manifest.descriptors.slice(0, descriptorCount),
    DURABLE_MANIFEST_PREFIX_DIGEST_DOMAIN,
    DURABLE_MANIFEST_DIGEST_VERSION,
  );
  return {
    offset,
    descriptorCount,
    prefixDigest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  };
}

/**
 * Check whether a persisted OFFSET is an exact graph boundary in the current
 * rootless manifest. Callers must construct and validate the plan once at the
 * completed META boundary; raw metadata is deliberately not a second mode.
 */
export function isGraphScopedDurableManifestBoundary(
  manifest: GraphScopedDurableManifestPlan,
  offset: number,
): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0) return false;
  if (offset === 0) return true;

  let boundary = 0;
  for (const descriptor of manifest.descriptors) {
    boundary += descriptor.publicTripleCount;
    if (!Number.isSafeInteger(boundary)) return false;
    if (offset === boundary) return true;
    if (offset < boundary) return false;
  }
  return false;
}

/**
 * Project an incomplete/resumed full snapshot onto a safe V2 graph prefix.
 *
 * This mirrors the responder's `buildExactGraphPagePlan` ordering. The raw
 * offset must start on a manifest boundary. The checkpointed projection must
 * be a contiguous prefix of the remaining exact graphs, but an interrupted
 * partitioned fetch may also contain rows beyond its first incomplete graph;
 * those non-contiguous tail rows are discarded for replay. Ownership or resume
 * ambiguity still fails closed by returning `null`, so callers cannot advance
 * a cursor on attacker-shaped metadata or a mixed legacy/V2 snapshot.
 */
export function planBoundedGraphScopedDurableBatch(
  dataQuads: readonly Quad[],
  manifest: GraphScopedDurableManifestPlan,
  resumedFromOffset: number,
  rawNextOffset: number,
  phaseCompleted: boolean,
  rawResumedFromOffset = resumedFromOffset,
  quadRawOffsets?: readonly number[],
): BoundedGraphScopedDurableBatch | null {
  if (
    !Number.isSafeInteger(resumedFromOffset)
    || resumedFromOffset < 0
    || !Number.isSafeInteger(rawNextOffset)
    || !Number.isSafeInteger(rawResumedFromOffset)
    || rawResumedFromOffset < 0
    || rawNextOffset < rawResumedFromOffset
  ) return null;

  const effectiveRawOffsets = quadRawOffsets === undefined
    ? rawNextOffset - rawResumedFromOffset === dataQuads.length
      ? dataQuads.map((_, index) => rawResumedFromOffset + index)
      : null
    : [...quadRawOffsets];
  if (
    effectiveRawOffsets === null
    || effectiveRawOffsets.length !== dataQuads.length
    || effectiveRawOffsets.some(
      (offset, index) => !Number.isSafeInteger(offset)
        || offset < rawResumedFromOffset
        || offset >= rawNextOffset
        || (index > 0 && offset <= effectiveRawOffsets[index - 1]!),
    )
  ) return null;

  const descriptors = manifest.descriptors;
  const descriptorByGraph = new Map(
    descriptors.map((descriptor) => [descriptor.assertionGraph, descriptor] as const),
  );

  const observedCounts = new Map<string, number>();
  for (const quad of dataQuads) {
    if (!descriptorByGraph.has(quad.graph)) return null;
    observedCounts.set(quad.graph, (observedCounts.get(quad.graph) ?? 0) + 1);
  }

  let manifestOffset = 0;
  let reachedResumeBoundary = resumedFromOffset === 0;
  let stoppedAtIncompleteGraph = false;
  let safeNextOffset = resumedFromOffset;
  let completedGraphCount = 0;
  const completeGraphs = new Set<string>();
  const completedPositiveGraphs: Array<{ graph: string; rowCount: number }> = [];

  // Zero-public V2 assets have no responder rows, but their metadata envelope
  // is independently verifiable. Keep them in scope on every bounded round;
  // this is idempotent and avoids an offset ambiguity for zero-width entries.
  for (const descriptor of descriptors) {
    if (descriptor.publicTripleCount === 0) completeGraphs.add(descriptor.assertionGraph);
  }

  for (const descriptor of descriptors) {
    const expected = descriptor.publicTripleCount;
    if (expected === 0) continue;
    const graphStart = manifestOffset;
    const graphEnd = graphStart + expected;
    if (!Number.isSafeInteger(graphEnd)) return null;
    manifestOffset = graphEnd;

    if (!reachedResumeBoundary) {
      if (graphEnd <= resumedFromOffset) {
        if ((observedCounts.get(descriptor.assertionGraph) ?? 0) !== 0) return null;
        continue;
      }
      if (graphStart !== resumedFromOffset) return null;
      reachedResumeBoundary = true;
    }

    const observed = observedCounts.get(descriptor.assertionGraph) ?? 0;
    if (stoppedAtIncompleteGraph) {
      // The responder can fetch exact graphs through independent partitions.
      // An interrupted round may therefore contain rows for later graphs even
      // though an earlier graph is short. Those rows are not part of the
      // contiguous checkpointable prefix, but their presence does not make the
      // already-complete leading graphs ambiguous: graph-scoped metadata still
      // gives every row an exact owner and the verifier authenticates each
      // selected graph before storage. Drop the non-contiguous tail and replay
      // it from the first incomplete boundary on the next round.
      continue;
    }
    if (observed === expected) {
      completeGraphs.add(descriptor.assertionGraph);
      completedPositiveGraphs.push({
        graph: descriptor.assertionGraph,
        rowCount: expected,
      });
      safeNextOffset += expected;
      completedGraphCount += 1;
      continue;
    }
    if (observed < 0 || observed > expected) return null;
    stoppedAtIncompleteGraph = true;
  }

  if (!reachedResumeBoundary || safeNextOffset > rawNextOffset) return null;

  // A timed-out fetch can stop exactly on a graph boundary without receiving
  // the terminal empty page. Do not checkpoint the final complete graph in
  // that case: the next round must receive at least one verified data graph so
  // its clean completion can serve as readiness evidence rather than an empty
  // terminal probe after all useful rows were persisted by timed-out rounds.
  if (!phaseCompleted && safeNextOffset === rawNextOffset && completedPositiveGraphs.length > 0) {
    const replay = completedPositiveGraphs.pop()!;
    completeGraphs.delete(replay.graph);
    safeNextOffset -= replay.rowCount;
    completedGraphCount -= 1;
  }

  const boundedData = dataQuads.filter((quad) => completeGraphs.has(quad.graph));
  if (boundedData.length !== safeNextOffset - resumedFromOffset) return null;
  const boundedRawOffsets = effectiveRawOffsets.filter(
    (_, index) => completeGraphs.has(dataQuads[index]!.graph),
  );
  let safeRawNextOffset = boundedRawOffsets.length > 0
    ? boundedRawOffsets[boundedRawOffsets.length - 1]! + 1
    : rawResumedFromOffset;
  if (phaseCompleted && safeNextOffset === manifestOffset) {
    // A terminal empty response proves every trailing raw row was either
    // consumed or filtered, so the immutable responder cursor is at EOF.
    safeRawNextOffset = rawNextOffset;
  }
  if (safeRawNextOffset > rawNextOffset) return null;

  return {
    dataQuads: boundedData,
    changedDataGraphs: [...completeGraphs],
    safeNextOffset,
    safeRawNextOffset,
    completedGraphCount,
    manifestRowCount: manifestOffset,
  };
}

export interface GraphScopedDescriptor {
  ual: string;
  contentScopeVersion: string;
  assertionVersion: string;
  contextGraphId: string;
  subGraphName?: string;
  assertionGraph: string;
  publicTripleCount: number;
  privateTripleCount: number;
  privateRoot?: Uint8Array;
  privateRootHex?: string;
  claimedRootHex: string;
  /** Canonical digest of every metadata row that will drive materialization. */
  metadataDigestHex: string;
}

interface IntegrityMetadataIndex {
  metaBySubject: Map<string, Quad[]>;
  dataIndexesByGraph: Map<string, number[]>;
  merkleSubjects: Set<string>;
  markerSubjects: Set<string>;
}

interface GraphScopedCandidate {
  kind: 'graph-scoped';
  ual: string;
  descriptor: GraphScopedDescriptor;
}

interface LegacyCandidate {
  kind: 'legacy';
  ual: string;
}

type IntegrityCandidate = GraphScopedCandidate | LegacyCandidate;

interface IntegrityMetadataRead {
  candidates: IntegrityCandidate[];
  invalidKcUals: Set<string>;
  fatalUnscopedFailure: boolean;
  logs: DurableIntegrityLogEntry[];
}

interface GraphScopedVerificationOutcome {
  hasGraphScopedCandidates: boolean;
  admittedMetadataUals: Set<string>;
  authenticatedMetadataUals: Set<string>;
  rejectedKcUals: Set<string>;
  graphVerification: Map<string, boolean>;
  verifiedGraphScopedDataGraphs: Set<string>;
  verifiedZeroPublicAssets: number;
  fatalUnscopedFailure: boolean;
  logs: DurableIntegrityLogEntry[];
}

interface LegacyVerificationOutcome {
  verifiedKcUals: Set<string>;
  authenticatedKcUals: Set<string>;
  rejectedKcUals: Set<string>;
  kaToKc: Map<string, string>;
  kcRootEntities: Map<string, string[]>;
  fatalUnscopedFailure: boolean;
  logs: DurableIntegrityLogEntry[];
}

interface IntegrityVerificationOutcome {
  hasGraphScopedCandidates: boolean;
  admittedMetadataUals: Set<string>;
  authenticatedMetadataUals: Set<string>;
  rejectedKcUals: Set<string>;
  graphVerification: Map<string, boolean>;
  verifiedGraphScopedDataGraphs: Set<string>;
  verifiedZeroPublicAssets: number;
  kaToKc: Map<string, string>;
  kcRootEntities: Map<string, string[]>;
  fatalUnscopedFailure: boolean;
  logs: DurableIntegrityLogEntry[];
}

/**
 * Verify one complete durable-sync batch and return indexes into the caller's
 * arrays. V2 assets are selected by their exact UAL-derived VM graph; legacy
 * assets retain the quarantined root-scoped verifier.
 */
export function selectVerifiedDurableSyncQuads(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
  acceptUnverified = false,
  mode: DurableIntegrityVerificationMode = { kind: 'fullSnapshot' },
): DurableIntegritySelection {
  const logs: DurableIntegrityLogEntry[] = [];
  if (metaQuads.length === 0) {
    if (!acceptUnverified && dataQuads.length > 0) {
      logs.push({
        level: 'warn',
        message: `Rejecting sync batch: received ${dataQuads.length} data triples but no KA integrity metadata`,
      });
      return {
        dataIndexes: [],
        metaIndexes: [],
        rejected: 1,
        droppedSyncControlTriples: 0,
        droppedNonIriSubjectTriples: 0,
        consumedUnpersistedMetaTriples: 0,
        verifiedZeroPublicAssets: 0,
        verifiedGraphScopedDataGraphs: [],
        logs,
      };
    }
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: [],
      rejected: 0,
      droppedSyncControlTriples: 0,
      droppedNonIriSubjectTriples: 0,
      consumedUnpersistedMetaTriples: 0,
      verifiedZeroPublicAssets: 0,
      verifiedGraphScopedDataGraphs: [],
      logs,
    };
  }

  // #1921 — sanitize the verification inputs ONCE at this boundary so a non-IRI
  // `_meta` subject can neither authenticate data (it never becomes a candidate)
  // NOR poison verification (the readIntegrityMetadata PART_OF scan and
  // verifyLegacyCandidates' raw scan never see it, so a `_:bad dkg:partOf
  // "<valid-ual>"` row cannot falsely invalidate a valid batch). Admission below
  // deliberately runs on the ORIGINAL metaQuads: the selectors still drop+count
  // non-IRI rows (persist-drop + meta-cursor advance) and index into the
  // original array. The verification outcome is subject-keyed, so no positional
  // remap is needed across the sanitized/original split.
  const iriMetaQuads = metaQuads.filter((quad) => isIriMetaSubject(quad.subject));
  const metadata = indexIntegrityMetadata(dataQuads, iriMetaQuads);
  if (metadata.merkleSubjects.size === 0 && metadata.markerSubjects.size === 0) {
    if (!acceptUnverified && dataQuads.length > 0) {
      logs.push({
        level: 'warn',
        message: `Rejecting sync batch: received ${dataQuads.length} data triples without a Merkle-bound KA descriptor`,
      });
      return {
        dataIndexes: [],
        metaIndexes: [],
        rejected: 1,
        droppedSyncControlTriples: 0,
        droppedNonIriSubjectTriples: 0,
        consumedUnpersistedMetaTriples: 0,
        verifiedZeroPublicAssets: 0,
        verifiedGraphScopedDataGraphs: [],
        logs,
      };
    }
    const selectedMetadata = selectAdmittedMetadataIndexes(
      metaQuads,
      metadata,
      new Set(),
      new Map(),
      new Set(),
    );
    logDroppedSyncControls(logs, selectedMetadata.droppedControls);
    logDroppedNonIriMetaSubjects(logs, selectedMetadata.droppedNonIriSubjectTriples);
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: selectedMetadata.indexes,
      rejected: 0,
      droppedSyncControlTriples: selectedMetadata.droppedControls,
      droppedNonIriSubjectTriples: selectedMetadata.droppedNonIriSubjectTriples,
      consumedUnpersistedMetaTriples: selectedMetadata.droppedControls + selectedMetadata.droppedNonIriSubjectTriples,
      verifiedZeroPublicAssets: 0,
      verifiedGraphScopedDataGraphs: [],
      logs,
    };
  }

  const parsed = readIntegrityMetadata(metadata, acceptUnverified);
  const graphScoped = verifyGraphScopedCandidates(
    dataQuads,
    metadata,
    parsed,
    acceptUnverified,
    mode,
  );
  const legacy = verifyLegacyCandidates(
    dataQuads,
    iriMetaQuads,
    metadata,
    parsed.candidates,
    acceptUnverified,
    mode,
  );
  const outcome: IntegrityVerificationOutcome = {
    hasGraphScopedCandidates: graphScoped.hasGraphScopedCandidates,
    admittedMetadataUals: new Set([
      ...graphScoped.admittedMetadataUals,
      ...legacy.verifiedKcUals,
    ]),
    authenticatedMetadataUals: new Set([
      ...graphScoped.authenticatedMetadataUals,
      ...legacy.authenticatedKcUals,
    ]),
    rejectedKcUals: new Set([...graphScoped.rejectedKcUals, ...legacy.rejectedKcUals]),
    graphVerification: graphScoped.graphVerification,
    verifiedGraphScopedDataGraphs: graphScoped.verifiedGraphScopedDataGraphs,
    verifiedZeroPublicAssets: graphScoped.verifiedZeroPublicAssets,
    kaToKc: legacy.kaToKc,
    kcRootEntities: legacy.kcRootEntities,
    fatalUnscopedFailure:
      graphScoped.fatalUnscopedFailure || legacy.fatalUnscopedFailure,
    logs: [...graphScoped.logs, ...legacy.logs],
  };

  return selectVerifiedQuads(
    dataQuads,
    metaQuads,
    metadata,
    outcome,
    acceptUnverified,
  );
}

function indexIntegrityMetadata(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
): IntegrityMetadataIndex {
  const metaBySubject = new Map<string, Quad[]>();
  const dataIndexesByGraph = new Map<string, number[]>();
  for (const quad of metaQuads) {
    const rows = metaBySubject.get(quad.subject);
    if (rows) rows.push(quad);
    else metaBySubject.set(quad.subject, [quad]);
  }
  for (let index = 0; index < dataQuads.length; index++) {
    const graph = dataQuads[index]!.graph;
    const indexes = dataIndexesByGraph.get(graph);
    if (indexes) indexes.push(index);
    else dataIndexesByGraph.set(graph, [index]);
  }

  const merkleSubjects = new Set<string>();
  const markerSubjects = new Set<string>();
  // #1921 PRECONDITION: callers MUST pass IRI-sanitized `_meta` quads. Both
  // current callers do — selectVerifiedDurableSyncQuads and
  // planBoundedGraphScopedDurableBatch filter non-IRI subjects at their boundary
  // before indexing — and any NEW caller MUST too. This function no longer
  // filters internally, so a non-IRI subject reaching here would re-enter
  // candidacy AND the metaBySubject-based verification scans
  // (readIntegrityMetadata's PART_OF scan, parseGraphScopedDescriptor), letting a
  // peer's blank-node/literal subject authenticate data OR poison a valid batch.
  // Admission (the selectors) deliberately runs on the ORIGINAL metaQuads and is
  // where non-IRI rows are dropped + counted.
  for (const quad of metaQuads) {
    if (quad.predicate === MERKLE_ROOT) {
      merkleSubjects.add(quad.subject);
    }
    if (
      quad.predicate === CONTENT_SCOPE_VERSION
      && isDeterministicKaMetadataSubject(quad.subject)
    ) {
      markerSubjects.add(quad.subject);
    }
  }

  return {
    metaBySubject,
    dataIndexesByGraph,
    merkleSubjects,
    markerSubjects,
  };
}

function readIntegrityMetadata(
  metadata: IntegrityMetadataIndex,
  acceptUnverified: boolean,
): IntegrityMetadataRead {
  const candidates: IntegrityCandidate[] = [];
  const invalidKcUals = new Set<string>();
  let fatalUnscopedFailure = false;
  const logs: DurableIntegrityLogEntry[] = [];

  for (const subject of new Set([
    ...metadata.merkleSubjects,
    ...metadata.markerSubjects,
  ])) {
    const rows = metadata.metaBySubject.get(subject) ?? [];
    const markerValues = distinctObjects(rows, CONTENT_SCOPE_VERSION);
    if (markerValues.length === 0) {
      candidates.push({ kind: 'legacy', ual: subject });
      continue;
    }

    try {
      const versions = [...new Set(markerValues.map((raw) => parseInteger(raw, 'contentScopeVersion').toString()))];
      if (versions.length !== 1) {
        throw new Error('ambiguous contentScopeVersion metadata');
      }
      const version = BigInt(versions[0]!);
      if (!metadata.merkleSubjects.has(subject)) {
        throw new Error('missing merkleRoot metadata');
      }
      if (version === 1n) {
        candidates.push({ kind: 'legacy', ual: subject });
        continue;
      }
      if (version !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
        throw new Error(`unsupported contentScopeVersion ${version}`);
      }
      candidates.push({
        kind: 'graph-scoped',
        ual: subject,
        descriptor: parseGraphScopedDescriptor(subject, rows),
      });
    } catch (error) {
      invalidKcUals.add(subject);
      fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Invalid graph-scoped KA metadata for ${subject}: ${errorMessage(error)}`,
      });
    }
  }

  // One physical graph is one V2 KA. A second metadata subject claiming the
  // same graph makes ownership ambiguous, so reject the batch rather than let
  // either subject authenticate the other's payload.
  const graphOwners = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.kind !== 'graph-scoped') continue;
    const { ual, descriptor } = candidate;
    const owner = graphOwners.get(descriptor.assertionGraph);
    if (owner && owner !== ual) {
      invalidKcUals.add(owner);
      invalidKcUals.add(ual);
      fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Graph-scoped KA assertion graph ${descriptor.assertionGraph} has multiple owners`,
      });
    } else {
      graphOwners.set(descriptor.assertionGraph, ual);
    }
  }

  // A V2 asset must never acquire legacy token/root ownership aliases. Check
  // token-level partOf rows here, after the candidate kind is known, so the
  // graph-scoped verifier owns this boundary rather than letting those rows
  // fall through as unrelated metadata during final selection.
  const graphScopedUals = new Set(
    candidates
      .filter((candidate): candidate is GraphScopedCandidate => candidate.kind === 'graph-scoped')
      .map((candidate) => candidate.ual),
  );
  for (const rows of metadata.metaBySubject.values()) {
    for (const quad of rows) {
      if (quad.predicate !== PART_OF) continue;
      const owner = stripLiteral(quad.object);
      if (!graphScopedUals.has(owner)) continue;
      if (!invalidKcUals.has(owner)) {
        logs.push({
          level: acceptUnverified ? 'debug' : 'warn',
          message: `Invalid graph-scoped KA metadata for ${owner}: token-level legacy ownership binding`,
        });
      }
      invalidKcUals.add(owner);
      fatalUnscopedFailure = true;
    }
  }

  return {
    candidates: candidates.filter((candidate) => !invalidKcUals.has(candidate.ual)),
    invalidKcUals,
    fatalUnscopedFailure,
    logs,
  };
}

function verifyGraphScopedCandidates(
  dataQuads: readonly Quad[],
  metadata: IntegrityMetadataIndex,
  parsed: IntegrityMetadataRead,
  acceptUnverified: boolean,
  mode: DurableIntegrityVerificationMode,
): GraphScopedVerificationOutcome {
  const graphScopedCandidates = parsed.candidates.filter(
    (candidate): candidate is GraphScopedCandidate => candidate.kind === 'graph-scoped',
  );
  const admittedMetadataUals = new Set<string>();
  const authenticatedMetadataUals = new Set<string>();
  const rejectedKcUals = new Set<string>(parsed.invalidKcUals);
  const graphVerification = new Map<string, boolean>();
  const verifiedGraphScopedDataGraphs = new Set<string>();
  let verifiedZeroPublicAssets = 0;
  let fatalUnscopedFailure = parsed.fatalUnscopedFailure;
  const logs = [...parsed.logs];

  for (const candidate of graphScopedCandidates) {
    const { ual, descriptor } = candidate;
    let scope: ReturnType<typeof classifyGraphScopedCandidateScope>;
    try {
      scope = classifyGraphScopedCandidateScope(ual, descriptor.assertionGraph, metadata, mode);
    } catch (error) {
      rejectedKcUals.add(ual);
      fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Invalid graph-scoped KA delta metadata for ${ual}: ${errorMessage(error)}`,
      });
      continue;
    }
    // Changelog and since-batch responses carry complete shared metadata but
    // only a scoped data payload. Out-of-scope descriptors are structurally
    // valid, yet their peer-supplied rows are not authenticated by this page.
    if (scope !== 'in-scope') {
      // The shared metadata record includes descriptors for unchanged assets.
      // They are structurally valid but not authenticated by this page's
      // payload, so never select their peer-supplied rows for replacement.
      // System graphs retain their explicit unverified-data override.
      if (scope === 'tentative-without-batch') {
        graphVerification.set(descriptor.assertionGraph, false);
      }
      if (acceptUnverified) admittedMetadataUals.add(ual);
      continue;
    }

    const indexes = metadata.dataIndexesByGraph.get(descriptor.assertionGraph) ?? [];
    const publicQuads = indexes.map((index) => dataQuads[index]!);
    let computedHex: string | undefined;
    if (publicQuads.length === descriptor.publicTripleCount) {
      computedHex = toHex(computeStructuredKCRoot(
        publicQuads,
        descriptor.privateRoot ? [descriptor.privateRoot] : [],
      ));
    } else {
      // A short exact graph may mean that part of the advertised V2 payload
      // arrived under another graph (or that a paged fetch was incomplete).
      // Its ownership is unknowable from RDF subjects, so reject the whole
      // batch instead of letting those quads pass as unrelated data.
      fatalUnscopedFailure = true;
    }
    const verified = computedHex === descriptor.claimedRootHex;
    graphVerification.set(descriptor.assertionGraph, verified);
    if (verified) {
      admittedMetadataUals.add(ual);
      authenticatedMetadataUals.add(ual);
      verifiedGraphScopedDataGraphs.add(descriptor.assertionGraph);
      if (descriptor.publicTripleCount === 0) verifiedZeroPublicAssets += 1;
      continue;
    }

    rejectedKcUals.add(ual);
    const detail = publicQuads.length !== descriptor.publicTripleCount
      ? `public triple count mismatch: metadata=${descriptor.publicTripleCount}, fetched=${publicQuads.length}`
      : `claimed ${descriptor.claimedRootHex.slice(0, 16)}…, computed ${(computedHex ?? '').slice(0, 16)}…`;
    logs.push({
      level: acceptUnverified ? 'debug' : 'warn',
      message: `Merkle mismatch for graph-scoped KA ${ual}${acceptUnverified ? ' (system context graph, accepted)' : ''}: ${detail}`,
    });
  }

  return {
    hasGraphScopedCandidates: graphScopedCandidates.length > 0,
    admittedMetadataUals,
    authenticatedMetadataUals,
    rejectedKcUals,
    graphVerification,
    verifiedGraphScopedDataGraphs,
    verifiedZeroPublicAssets,
    fatalUnscopedFailure,
    logs,
  };
}

function verifyLegacyCandidates(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
  metadata: IntegrityMetadataIndex,
  candidates: readonly IntegrityCandidate[],
  acceptUnverified: boolean,
  mode: DurableIntegrityVerificationMode,
): LegacyVerificationOutcome {
  const legacyKcUals = new Set(
    candidates
      .filter((candidate): candidate is LegacyCandidate => candidate.kind === 'legacy')
      .map((candidate) => candidate.ual),
  );
  const verifiedKcUals = new Set<string>();
  const authenticatedKcUals = new Set<string>();
  const rejectedKcUals = new Set<string>();
  let fatalUnscopedFailure = false;
  const logs: DurableIntegrityLogEntry[] = [];

  // Rootless V2 batches have no legacy root-entity ownership to reconstruct.
  // `skolemizeByEntity` is intentionally a legacy compatibility index whose
  // implementation scans the full dataset once per distinct root entity. On a
  // graph-scoped KA with thousands of ordinary subjects that turns otherwise
  // linear verification into O(subjects * triples) work even though the result
  // is never read. Return the empty legacy outcome before building that index.
  if (legacyKcUals.size === 0) {
    return {
      verifiedKcUals,
      authenticatedKcUals,
      rejectedKcUals,
      kaToKc: new Map(),
      kcRootEntities: new Map(),
      fatalUnscopedFailure,
      logs,
    };
  }

  // Legacy read-only verification. Token rows use partOf; collapsed legacy
  // rows self-map from the merkle-bearing UAL to their rootEntity rows.
  const kaToKc = new Map<string, string>();
  const kaRootEntities = new Map<string, string[]>();
  for (const quad of metaQuads) {
    if (quad.predicate === PART_OF) {
      const kcUal = stripLiteral(quad.object);
      if (legacyKcUals.has(kcUal)) kaToKc.set(quad.subject, kcUal);
    } else if (quad.predicate === ROOT_ENTITY) {
      const roots = kaRootEntities.get(quad.subject);
      const root = stripLiteral(quad.object);
      if (roots) roots.push(root);
      else kaRootEntities.set(quad.subject, [root]);
    }
  }
  for (const kcUal of legacyKcUals) {
    if (kaRootEntities.has(kcUal) && !kaToKc.has(kcUal)) {
      kaToKc.set(kcUal, kcUal);
    }
  }

  const kcRootEntities = new Map<string, string[]>();
  for (const [kaUri, kcUal] of kaToKc) {
    const roots = kaRootEntities.get(kaUri);
    if (!roots) continue;
    let joined = kcRootEntities.get(kcUal);
    if (!joined) {
      joined = [];
      kcRootEntities.set(kcUal, joined);
    }
    for (const root of roots) {
      if (!joined.includes(root)) joined.push(root);
    }
  }

  const rootEntityToKcs = new Map<string, string[]>();
  for (const [kcUal, roots] of kcRootEntities) {
    for (const root of roots) {
      const owners = rootEntityToKcs.get(root);
      if (owners) owners.push(kcUal);
      else rootEntityToKcs.set(root, [kcUal]);
    }
  }
  const overlappingLegacyKcs = new Set<string>();
  for (const owners of rootEntityToKcs.values()) {
    if (owners.length > 1) owners.forEach((owner) => overlappingLegacyKcs.add(owner));
  }

  const partitioned = skolemizeByEntity(dataQuads as Quad[]);
  for (const kcUal of legacyKcUals) {
    if (!metadata.merkleSubjects.has(kcUal)) continue;
    if (mode.kind === 'sinceBatchId') {
      try {
        if (!candidateIsNewerThan(metadata.metaBySubject.get(kcUal) ?? [], mode.sinceBatchId)) {
          if (acceptUnverified) verifiedKcUals.add(kcUal);
          continue;
        }
      } catch (error) {
        rejectedKcUals.add(kcUal);
        fatalUnscopedFailure = true;
        logs.push({
          level: acceptUnverified ? 'debug' : 'warn',
          message: `Invalid legacy KA delta metadata for ${kcUal}: ${errorMessage(error)}`,
        });
        continue;
      }
    }
    const roots = kcRootEntities.get(kcUal) ?? [];
    let claimedRoots: string[];
    try {
      claimedRoots = distinctObjects(metadata.metaBySubject.get(kcUal) ?? [], MERKLE_ROOT)
        .map((raw) => normalizeHex32(raw, 'merkleRoot'));
    } catch (error) {
      rejectedKcUals.add(kcUal);
      if (roots.length === 0) fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Unverifiable legacy KA ${kcUal}: ${errorMessage(error)}`,
      });
      continue;
    }
    if (claimedRoots.length !== 1 || roots.length === 0) {
      rejectedKcUals.add(kcUal);
      fatalUnscopedFailure = true;
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Unverifiable legacy KA ${kcUal}: ${claimedRoots.length !== 1 ? 'ambiguous merkleRoot' : 'missing rootEntity metadata'}`,
      });
      continue;
    }
    try {
      const privateRoots: Uint8Array[] = [];
      for (const [kaUri, owner] of kaToKc) {
        if (owner !== kcUal) continue;
        for (const raw of distinctObjects(metadata.metaBySubject.get(kaUri) ?? [], PRIVATE_MERKLE_ROOT)) {
          privateRoots.push(hexToBytes(normalizeHex32(raw, 'privateMerkleRoot')));
        }
      }
      const legacyDataGraph = legacyDataGraphFromMetadata(kcUal, metadata);
      if (
        mode.kind === 'changelogPage'
        && (
          legacyDataGraph === undefined
          || !mode.changedDataGraphs.has(legacyDataGraph)
        )
      ) {
        // Changelog pages carry the complete shared metadata graph but only
        // changed data graphs. Do not select unchanged peer-supplied legacy
        // rows for whole-graph replacement when their payload was not checked.
        if (acceptUnverified) verifiedKcUals.add(kcUal);
        continue;
      }
      if (overlappingLegacyKcs.has(kcUal)) {
        verifiedKcUals.add(kcUal);
        authenticatedKcUals.add(kcUal);
        logs.push({
          level: 'debug',
          message: `Skipping legacy Merkle check for ${kcUal}: root entity is shared across versions`,
        });
        continue;
      }

      const publicQuads: Quad[] = [];
      for (const root of roots) appendInPlace(publicQuads, partitioned.get(root) ?? []);
      const computedHex = toHex(computeStructuredKCRoot(publicQuads, privateRoots));
      if (computedHex === claimedRoots[0]) {
        verifiedKcUals.add(kcUal);
        authenticatedKcUals.add(kcUal);
      } else {
        rejectedKcUals.add(kcUal);
        logs.push({
          level: acceptUnverified ? 'debug' : 'warn',
          message: `Merkle mismatch for ${kcUal}${acceptUnverified ? ' (system context graph, accepted)' : ''}: claimed ${claimedRoots[0]!.slice(0, 16)}…, computed ${computedHex.slice(0, 16)}…`,
        });
      }
    } catch (error) {
      rejectedKcUals.add(kcUal);
      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Merkle verification error for ${kcUal}: ${errorMessage(error)}`,
      });
    }
  }

  return {
    verifiedKcUals,
    authenticatedKcUals,
    rejectedKcUals,
    kaToKc,
    kcRootEntities,
    fatalUnscopedFailure,
    logs,
  };
}

function classifyGraphScopedCandidateScope(
  ual: string,
  assertionGraph: string,
  metadata: IntegrityMetadataIndex,
  mode: DurableIntegrityVerificationMode,
): 'in-scope' | 'out-of-scope' | 'tentative-without-batch' {
  if (mode.kind === 'fullSnapshot') return 'in-scope';
  if (mode.kind === 'changelogPage') {
    return mode.changedDataGraphs.has(assertionGraph) ? 'in-scope' : 'out-of-scope';
  }
  const rows = metadata.metaBySubject.get(ual) ?? [];
  const batchIds = distinctObjects(rows, BATCH_ID);
  const statuses = distinctObjects(rows, STATUS);
  if (batchIds.length === 0 && statuses.length === 1 && statuses[0] === 'tentative') {
    return 'tentative-without-batch';
  }
  return candidateIsNewerThan(rows, mode.sinceBatchId) ? 'in-scope' : 'out-of-scope';
}

function candidateIsNewerThan(rows: readonly Quad[], sinceBatchId: bigint): boolean {
  const values = distinctObjects(rows, BATCH_ID);
  if (values.length !== 1) {
    throw new Error(`${values.length === 0 ? 'missing' : 'ambiguous'} batchId metadata`);
  }
  const batchId = parseInteger(values[0]!, 'batchId');
  if (batchId < 0n) throw new Error(`invalid batchId: ${batchId}`);
  return batchId > sinceBatchId;
}

function legacyDataGraphFromMetadata(
  kcUal: string,
  metadata: IntegrityMetadataIndex,
): string | undefined {
  const metaGraphs = new Set(
    (metadata.metaBySubject.get(kcUal) ?? [])
      .filter((quad) => quad.predicate === MERKLE_ROOT)
      .map((quad) => quad.graph),
  );
  if (metaGraphs.size !== 1) return undefined;
  const [metaGraph] = metaGraphs;
  return metaGraph?.endsWith('/_meta')
    ? metaGraph.slice(0, -'/_meta'.length)
    : undefined;
}

function selectVerifiedQuads(
  dataQuads: readonly Quad[],
  metaQuads: readonly Quad[],
  metadata: IntegrityMetadataIndex,
  outcome: IntegrityVerificationOutcome,
  acceptUnverified: boolean,
): DurableIntegritySelection {
  const logs = [...outcome.logs];
  const verifiedGraphScopedDataGraphs = [...outcome.verifiedGraphScopedDataGraphs].sort();

  const verifiedLegacyRoots = new Set<string>();
  const allLegacyRoots = new Set<string>();
  for (const [kcUal, roots] of outcome.kcRootEntities) {
    for (const root of roots) {
      allLegacyRoots.add(root);
      if (outcome.admittedMetadataUals.has(kcUal)) verifiedLegacyRoots.add(root);
    }
  }

  const dataIndexes: number[] = [];
  let unboundDataTriples = 0;
  let detachedLegacyProjectionTriples = 0;
  for (let index = 0; index < dataQuads.length; index++) {
    const quad = dataQuads[index]!;
    const graphVerified = outcome.graphVerification.get(quad.graph);
    if (graphVerified !== undefined) {
      if (graphVerified) dataIndexes.push(index);
      continue;
    }
    const legacyOwner = findLegacyRootOwner(quad.subject, allLegacyRoots);
    if (legacyOwner) {
      if (verifiedLegacyRoots.has(legacyOwner)) dataIndexes.push(index);
      continue;
    }
    // Rootless V2 KAs are authoritative only in their UAL-derived assertion
    // graphs. Older finalization code may leave a detached aggregate
    // `/context/<id>` projection (plus its metadata and public catalog) beside
    // those exact graphs. These reserved projections have no V2 integrity
    // binding and must never be inserted, but their presence must not turn an
    // otherwise fully verified rootless snapshot into an all-or-nothing retry.
    // Arbitrary unbound graphs still take the strict rejection path below.
    if (
      outcome.hasGraphScopedCandidates
      && isDetachedLegacyProjectionGraph(quad.graph)
    ) {
      detachedLegacyProjectionTriples += 1;
      continue;
    }
    if (outcome.hasGraphScopedCandidates) unboundDataTriples += 1;
    else dataIndexes.push(index); // quarantined legacy compatibility
  }

  if (detachedLegacyProjectionTriples > 0) {
    logs.push({
      level: 'debug',
      message: `Dropped ${detachedLegacyProjectionTriples} detached legacy projection triples from rootless sync batch`,
    });
  }
  if (unboundDataTriples > 0) {
    logs.push({
      level: acceptUnverified ? 'debug' : 'warn',
      message: `Rejecting sync batch: ${unboundDataTriples} data triples are not bound to a verified KA`,
    });
  }
  const rejected = outcome.rejectedKcUals.size + (
    unboundDataTriples > 0 && outcome.rejectedKcUals.size === 0 ? 1 : 0
  );
  if (acceptUnverified && rejected > 0) {
    // Preserve the established audit wording consumed by worker/runtime
    // diagnostics while the verifier supports both legacy KCs and V2 KAs.
    logs.push({ level: 'debug', message: `Accepting ${rejected} unverified KC(s) (system context graph)` });
    const selectedMetadata = selectSystemOverrideMetadataIndexes(
      metaQuads,
      metadata,
      outcome.authenticatedMetadataUals,
      outcome.kaToKc,
    );
    logDroppedSyncControls(logs, selectedMetadata.droppedControls);
    logDroppedNonIriMetaSubjects(logs, selectedMetadata.droppedNonIriSubjectTriples);
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: selectedMetadata.indexes,
      rejected: 0,
      droppedSyncControlTriples: selectedMetadata.droppedControls,
      droppedNonIriSubjectTriples: selectedMetadata.droppedNonIriSubjectTriples,
      consumedUnpersistedMetaTriples: selectedMetadata.droppedControls + selectedMetadata.droppedNonIriSubjectTriples,
      verifiedZeroPublicAssets: outcome.verifiedZeroPublicAssets,
      verifiedGraphScopedDataGraphs,
      logs,
    };
  }
  if (outcome.fatalUnscopedFailure || unboundDataTriples > 0) {
    return {
      dataIndexes: [],
      metaIndexes: [],
      rejected,
      droppedSyncControlTriples: 0,
      droppedNonIriSubjectTriples: 0,
      consumedUnpersistedMetaTriples: 0,
      verifiedZeroPublicAssets: outcome.verifiedZeroPublicAssets,
      // Keep this list aligned with the selected data + metadata indexes.
      // A fatal batch deliberately selects neither. Returning the names of
      // individually verified graphs here makes the requester attempt exact
      // materialization without their selected descriptors, which masks the
      // original integrity failure as a misleading "0 metadata owners" error.
      verifiedGraphScopedDataGraphs: [],
      logs,
    };
  }

  const selectedMetadata = selectAdmittedMetadataIndexes(
    metaQuads,
    metadata,
    outcome.admittedMetadataUals,
    outcome.kaToKc,
    outcome.authenticatedMetadataUals,
  );
  logDroppedSyncControls(logs, selectedMetadata.droppedControls);
  logDroppedNonIriMetaSubjects(logs, selectedMetadata.droppedNonIriSubjectTriples);

  return {
    dataIndexes,
    metaIndexes: selectedMetadata.indexes,
    rejected,
    droppedSyncControlTriples: selectedMetadata.droppedControls,
    droppedNonIriSubjectTriples: selectedMetadata.droppedNonIriSubjectTriples,
    consumedUnpersistedMetaTriples: selectedMetadata.droppedControls + selectedMetadata.droppedNonIriSubjectTriples,
    verifiedZeroPublicAssets: outcome.verifiedZeroPublicAssets,
    verifiedGraphScopedDataGraphs,
    logs,
  };
}

function selectAdmittedMetadataIndexes(
  metaQuads: readonly Quad[],
  metadata: IntegrityMetadataIndex,
  admittedMetadataUals: ReadonlySet<string>,
  kaToKc: ReadonlyMap<string, string>,
  authenticatedMetadataUals: ReadonlySet<string>,
): { indexes: number[]; droppedControls: number; droppedNonIriSubjectTriples: number } {
  const indexes: number[] = [];
  let droppedControls = 0;
  let droppedNonIriSubjectTriples = 0;
  for (let index = 0; index < metaQuads.length; index++) {
    const quad = metaQuads[index]!;
    // #1921 — admission runs on the ORIGINAL metaQuads (verification already ran
    // on the IRI-sanitized set at the boundary). A non-IRI descriptive row would
    // otherwise reach the descriptive fall-through below and be persisted, so
    // drop + count it here — that keeps it out of the store AND feeds the
    // meta-cursor consumed-row count (checkpoint advance). It could not reach the
    // merkle/marker branch regardless: the boundary sanitize keeps non-IRI
    // subjects out of `merkleSubjects`/`markerSubjects`.
    if (!isIriMetaSubject(quad.subject)) {
      droppedNonIriSubjectTriples += 1;
      continue;
    }
    if (
      metadata.merkleSubjects.has(quad.subject)
      || metadata.markerSubjects.has(quad.subject)
    ) {
      if (admittedMetadataUals.has(quad.subject)) {
        if (
          DURABLE_SYNC_CONTROL_PREDICATE_SET.has(quad.predicate)
          && !authenticatedMetadataUals.has(quad.subject)
        ) {
          droppedControls += 1;
        } else {
          indexes.push(index);
        }
      }
      continue;
    }

    const owner = kaToKc.get(quad.subject);
    if (owner) {
      if (admittedMetadataUals.has(owner)) {
        if (
          DURABLE_SYNC_CONTROL_PREDICATE_SET.has(quad.predicate)
          && !authenticatedMetadataUals.has(owner)
        ) {
          droppedControls += 1;
        } else {
          indexes.push(index);
        }
      }
      continue;
    }

    // A self-consistent graph-seal assertionVersion is descriptive metadata,
    // not a sync control — admit it via the descriptive path.
    if (isGraphSealDescriptiveVersion(quad, metadata)) {
      indexes.push(index);
      continue;
    }
    if (DURABLE_SYNC_CONTROL_PREDICATE_SET.has(quad.predicate)) {
      if (isAuthenticatedSyncControl(
        quad,
        metadata,
        authenticatedMetadataUals,
        kaToKc,
      )) {
        indexes.push(index);
      } else {
        droppedControls += 1;
      }
      continue;
    }
    indexes.push(index);
  }
  return { indexes, droppedControls, droppedNonIriSubjectTriples };
}

function selectSystemOverrideMetadataIndexes(
  metaQuads: readonly Quad[],
  metadata: IntegrityMetadataIndex,
  authenticatedMetadataUals: ReadonlySet<string>,
  kaToKc: ReadonlyMap<string, string>,
): { indexes: number[]; droppedControls: number; droppedNonIriSubjectTriples: number } {
  const indexes: number[] = [];
  let droppedControls = 0;
  let droppedNonIriSubjectTriples = 0;
  for (let index = 0; index < metaQuads.length; index++) {
    const quad = metaQuads[index]!;
    // #1921 — reject a non-IRI durable `_meta` subject at ingest. This terminal
    // system-CG selector admits every non-control row, so without this guard a
    // blank-node subject bearing ANY descriptive or integrity predicate
    // (e.g. `dkg:merkleRoot`) would be persisted and later served back.
    if (!isIriMetaSubject(quad.subject)) {
      droppedNonIriSubjectTriples += 1;
      continue;
    }
    if (
      DURABLE_SYNC_CONTROL_PREDICATE_SET.has(quad.predicate)
      && !isGraphSealDescriptiveVersion(quad, metadata)
      && !isAuthenticatedSyncControl(
        quad,
        metadata,
        authenticatedMetadataUals,
        kaToKc,
      )
    ) {
      droppedControls += 1;
      continue;
    }
    indexes.push(index);
  }
  return { indexes, droppedControls, droppedNonIriSubjectTriples };
}

/**
 * GH#1778 — classify a `dkg:assertionVersion` row as DESCRIPTIVE author-seal
 * metadata rather than a delta/routing control. A graph-scoped author seal
 * (subject carries `dkg:assertionMerkleRoot`) is descriptive: its 13 sibling
 * quads (Merkle root, EIP-712 attestation, `dkg:kaUal`, counts) already sync
 * unauthenticated, and the seal's authenticity is established at PUBLISH time
 * (`parseAssertionSealQuads` + a Merkle recompute), not here. Only
 * `dkg:assertionVersion` collides with the sync-control set, so for a
 * not-yet-published KA it was being stripped — leaving 13/14 quads and making
 * `parseAssertionSealQuads` throw "Partial graph-scoped assertion seal".
 *
 * Classifying it here (via the core `parseGraphScopedAssertionSealCandidate`
 * check — the SAME canonical "publishable graph-scoped seal" definition VM
 * publish uses: complete v2 seal whose kaUal author == authorAddress ==
 * `.../assertion/<addr>/…` coordinate, single-valued identity fields) keeps the
 * control-authentication abstraction honest: the seal field follows the
 * descriptive path instead of being smuggled through `isAuthenticatedSyncControl`
 * as an "authenticated control". A peer that forges a version value gains nothing
 * the sibling quads didn't already allow — a tampered version derives the wrong
 * graph scope and fails closed at publish.
 */
function isGraphSealDescriptiveVersion(quad: Quad, metadata: IntegrityMetadataIndex): boolean {
  return quad.predicate === ASSERTION_VERSION
    && parseGraphScopedAssertionSealCandidate(metadata.metaBySubject.get(quad.subject) ?? [], quad.subject) !== undefined;
}

function isAuthenticatedSyncControl(
  quad: Quad,
  metadata: IntegrityMetadataIndex,
  authenticatedMetadataUals: ReadonlySet<string>,
  kaToKc: ReadonlyMap<string, string>,
): boolean {
  if (authenticatedMetadataUals.has(quad.subject)) return true;
  const legacyOwner = kaToKc.get(quad.subject);
  if (legacyOwner && authenticatedMetadataUals.has(legacyOwner)) return true;
  if (quad.predicate === BATCH_ID) return false;

  // V2 lifecycle/seal rows may repeat graph scope away from the UAL subject.
  // Admit only an exact copy of one verified descriptor's immutable scope;
  // a peer cannot use this path to introduce a different graph or version.
  const rows = metadata.metaBySubject.get(quad.subject) ?? [];
  // The immutable V2 descriptor is keyed directly by dkg:kaUal, while the
  // named-KA lifecycle subject carries the same identity as dkg:reservedUal.
  // Publishing re-points that lifecycle subject to the canonical VM graph;
  // authenticate the repeated scope through either exact identity predicate.
  // Combining them (rather than preferring one) makes conflicting peer input
  // fail closed.
  const owners = [...new Set([
    ...distinctObjects(rows, KA_UAL),
    ...distinctObjects(rows, RESERVED_UAL),
  ].map(stripLiteral))];
  if (owners.length !== 1 || !authenticatedMetadataUals.has(owners[0]!)) return false;
  const descriptorRows = metadata.metaBySubject.get(owners[0]!) ?? [];
  try {
    const scopeVersions = distinctObjects(rows, CONTENT_SCOPE_VERSION)
      .map((value) => parseInteger(value, 'contentScopeVersion'));
    const repeatedVersions = distinctObjects(rows, ASSERTION_VERSION)
      .map((value) => parseInteger(value, 'assertionVersion'));
    const descriptorVersions = distinctObjects(descriptorRows, ASSERTION_VERSION)
      .map((value) => parseInteger(value, 'assertionVersion'));
    const repeatedGraphs = distinctObjects(rows, ASSERTION_GRAPH).map(stripLiteral);
    const descriptorGraphs = distinctObjects(descriptorRows, ASSERTION_GRAPH).map(stripLiteral);
    return scopeVersions.length === 1
      && scopeVersions[0] === BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)
      && repeatedVersions.length === 1
      && descriptorVersions.length === 1
      && repeatedVersions[0] === descriptorVersions[0]
      && repeatedGraphs.length === 1
      && descriptorGraphs.length === 1
      && repeatedGraphs[0] === descriptorGraphs[0];
  } catch {
    return false;
  }
}

function logDroppedSyncControls(
  logs: DurableIntegrityLogEntry[],
  droppedControls: number,
): void {
  if (droppedControls === 0) return;
  logs.push({
    level: 'warn',
    message: `Dropped ${droppedControls} unverified durable sync control metadata triple(s)`,
  });
}

function logDroppedNonIriMetaSubjects(
  logs: DurableIntegrityLogEntry[],
  dropped: number,
): void {
  if (dropped === 0) return;
  logs.push({
    level: 'warn',
    message: `Dropped ${dropped} non-IRI durable _meta subject triple(s) from peer ingest (#1921)`,
  });
}

function isDetachedLegacyProjectionGraph(graph: string): boolean {
  if (!graph.startsWith('did:dkg:context-graph:')) return false;
  return graph.endsWith('/_catalog')
    || /\/context\/[0-9]+(?:\/_meta)?$/.test(graph);
}

/**
 * Durable V2 KA descriptors live on the deterministic UAL subject itself.
 * Lifecycle, seal and SWM operation rows deliberately repeat scope fields on
 * other subjects; treating those rows as KA descriptors makes an otherwise
 * valid sync batch fail for lacking `dkg:merkleRoot`.
 *
 * Keep syntactically deterministic-but-noncanonical UALs in the candidate set
 * so they still fail closed in `parseGraphScopedDescriptor` instead of being
 * mistaken for harmless configuration metadata.
 */
function isDeterministicKaMetadataSubject(subject: string): boolean {
  if (!/^did:dkg:[^/]+\/0x[0-9a-fA-F]{40}\/[0-9]+$/.test(subject)) return false;
  try {
    parseDeterministicKnowledgeAssetUal(subject);
  } catch {
    // Shape matched, so this is a malformed KA descriptor and must remain in
    // the integrity envelope for the verifier to reject.
  }
  return true;
}

export function parseGraphScopedDescriptor(
  ual: string,
  rows: readonly Quad[],
): GraphScopedDescriptor {
  const requireSingle = (predicate: string, field: string): string => {
    const values = distinctObjects(rows, predicate);
    if (values.length !== 1) {
      throw new Error(`${values.length === 0 ? 'missing' : 'ambiguous'} ${field} metadata`);
    }
    return values[0]!;
  };
  const optionalSingle = (predicate: string, field: string): string | undefined => {
    const values = distinctObjects(rows, predicate);
    if (values.length > 1) throw new Error(`ambiguous ${field} metadata`);
    return values[0];
  };

  const metadataUal = requireSingle(KA_UAL, 'kaUal');
  if (metadataUal !== ual) throw new Error(`kaUal mismatch: found ${metadataUal}`);
  const contentScopeVersion = parseInteger(
    requireSingle(CONTENT_SCOPE_VERSION, 'contentScopeVersion'),
    'contentScopeVersion',
  );
  const assertionVersion = parseInteger(
    requireSingle(ASSERTION_VERSION, 'assertionVersion'),
    'assertionVersion',
  );
  const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
  if (scope.ual !== ual) throw new Error(`non-canonical kaUal: expected ${scope.ual}`);

  const contextGraphUri = requireSingle(CONTEXT_GRAPH, 'contextGraph');
  const contextGraphPrefix = 'did:dkg:context-graph:';
  if (!contextGraphUri.startsWith(contextGraphPrefix)) {
    throw new Error(`invalid contextGraph metadata: ${contextGraphUri}`);
  }
  const contextGraphId = contextGraphUri.slice(contextGraphPrefix.length);
  if (!contextGraphId) throw new Error('empty context graph id');
  const expectedMetaGraph = `${contextGraphUri}/_meta`;
  for (const row of rows) {
    if (row.graph !== expectedMetaGraph) {
      throw new Error(`metadata graph mismatch: expected ${expectedMetaGraph}, found ${row.graph}`);
    }
    if (row.predicate === ROOT_ENTITY || row.predicate === PART_OF) {
      throw new Error('graph-scoped KA metadata must not contain legacy root bindings');
    }
  }

  const subGraphRaw = optionalSingle(SUB_GRAPH_NAME, 'subGraphName');
  const subGraphName = subGraphRaw === undefined ? undefined : stripLiteral(subGraphRaw);
  if (subGraphName !== undefined) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`invalid subGraphName: ${validation.reason}`);
  }

  const expectedAssertionGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    subGraphName,
  );
  const assertionGraph = requireSingle(ASSERTION_GRAPH, 'assertionGraph');
  if (assertionGraph !== expectedAssertionGraph) {
    throw new Error(`assertionGraph mismatch: expected ${expectedAssertionGraph}, found ${assertionGraph}`);
  }

  const publicTripleCount = safeCount(
    requireSingle(PUBLIC_TRIPLE_COUNT, 'publicTripleCount'),
    'publicTripleCount',
  );
  const privateTripleCount = safeCount(
    requireSingle(PRIVATE_TRIPLE_COUNT, 'privateTripleCount'),
    'privateTripleCount',
  );
  if (publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error('empty graph-scoped asset');
  }
  const privateRootValues = distinctObjects(rows, PRIVATE_MERKLE_ROOT);
  if (privateTripleCount > 0 && privateRootValues.length !== 1) {
    throw new Error(`${privateRootValues.length === 0 ? 'missing' : 'ambiguous'} privateMerkleRoot metadata`);
  }
  if (privateTripleCount === 0 && privateRootValues.length > 0) {
    throw new Error('privateMerkleRoot present without private content');
  }
  const privateRootHex = privateRootValues[0]
    ? normalizeHex32(privateRootValues[0], 'privateMerkleRoot')
    : undefined;

  return {
    ual,
    contentScopeVersion: contentScopeVersion.toString(),
    assertionVersion: assertionVersion.toString(),
    contextGraphId,
    ...(subGraphName === undefined ? {} : { subGraphName }),
    assertionGraph,
    publicTripleCount,
    privateTripleCount,
    ...(privateRootHex
      ? {
          privateRoot: hexToBytes(privateRootHex),
          privateRootHex,
        }
      : {}),
    claimedRootHex: normalizeHex32(requireSingle(MERKLE_ROOT, 'merkleRoot'), 'merkleRoot'),
    metadataDigestHex: digestGraphScopedMetadataRows(rows),
  };
}

function distinctObjects(rows: readonly Quad[], predicate: string): string[] {
  return [...new Set(rows.filter((quad) => quad.predicate === predicate).map((quad) => stripLiteral(quad.object)))];
}

function parseInteger(raw: string, field: string): bigint {
  if (!/^-?\d+$/.test(raw)) throw new Error(`invalid ${field}: ${raw}`);
  return BigInt(raw);
}

function safeCount(raw: string, field: string): number {
  const value = parseInteger(raw, field);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`invalid ${field}: ${value}`);
  }
  return Number(value);
}

function normalizeHex32(raw: string, field: string): string {
  const hex = stripLiteral(raw).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${field} must be exactly 32 bytes of hexadecimal data`);
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

function stripLiteral(raw: string): string {
  const match = raw.match(/^"(.*)"(?:\^\^.*|@.*)?$/);
  return match ? match[1]! : raw;
}

function findLegacyRootOwner(subject: string, roots: ReadonlySet<string>): string | undefined {
  for (const root of roots) {
    if (subject === root || subject.startsWith(`${root}${SKOLEM_SUFFIX}`)) return root;
  }
  return undefined;
}

function allIndexes(source: readonly unknown[]): number[] {
  return Array.from({ length: source.length }, (_, index) => index);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
