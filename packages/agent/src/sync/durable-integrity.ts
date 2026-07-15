import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
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

const DKG_NS = 'http://dkg.io/ontology/';
const MERKLE_ROOT = `${DKG_NS}merkleRoot`;
const CONTENT_SCOPE_VERSION = `${DKG_NS}contentScopeVersion`;
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_VERSION = `${DKG_NS}assertionVersion`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;
const CONTEXT_GRAPH = `${DKG_NS}contextGraph`;
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
const DURABLE_INTEGRITY_META_PREDICATES: ReadonlySet<string> = new Set([
  MERKLE_ROOT,
  CONTENT_SCOPE_VERSION,
  KA_UAL,
  ASSERTION_VERSION,
  ASSERTION_GRAPH,
  PUBLIC_TRIPLE_COUNT,
  PRIVATE_TRIPLE_COUNT,
  PRIVATE_MERKLE_ROOT,
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
      DURABLE_INTEGRITY_META_PREDICATES.has(quad.predicate)
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
  | { kind: 'changelogPage'; changedDataGraphs: ReadonlySet<string> };

export interface DurableIntegritySelection {
  dataIndexes: number[];
  metaIndexes: number[];
  rejected: number;
  /** Verified V2 assets whose exact public assertion graph is intentionally empty. */
  verifiedZeroPublicAssets: number;
  /** Exact assertion graphs whose V2 descriptors and fetched payload verified. */
  verifiedGraphScopedDataGraphs: string[];
  logs: DurableIntegrityLogEntry[];
}

interface GraphScopedDescriptor {
  ual: string;
  assertionGraph: string;
  publicTripleCount: number;
  privateRoot?: Uint8Array;
  claimedRootHex: string;
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
  rejectedKcUals: Set<string>;
  graphVerification: Map<string, boolean>;
  verifiedGraphScopedDataGraphs: Set<string>;
  verifiedZeroPublicAssets: number;
  fatalUnscopedFailure: boolean;
  logs: DurableIntegrityLogEntry[];
}

interface LegacyVerificationOutcome {
  verifiedKcUals: Set<string>;
  rejectedKcUals: Set<string>;
  kaToKc: Map<string, string>;
  kcRootEntities: Map<string, string[]>;
  fatalUnscopedFailure: boolean;
  logs: DurableIntegrityLogEntry[];
}

interface IntegrityVerificationOutcome {
  hasGraphScopedCandidates: boolean;
  admittedMetadataUals: Set<string>;
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
        verifiedZeroPublicAssets: 0,
        verifiedGraphScopedDataGraphs: [],
        logs,
      };
    }
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: [],
      rejected: 0,
      verifiedZeroPublicAssets: 0,
      verifiedGraphScopedDataGraphs: [],
      logs,
    };
  }

  const metadata = indexIntegrityMetadata(dataQuads, metaQuads);
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
        verifiedZeroPublicAssets: 0,
        verifiedGraphScopedDataGraphs: [],
        logs,
      };
    }
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: allIndexes(metaQuads),
      rejected: 0,
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
    metaQuads,
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
  for (const quad of metaQuads) {
    if (quad.predicate === MERKLE_ROOT) {
      merkleSubjects.add(quad.subject);
    }
    if (quad.predicate === CONTENT_SCOPE_VERSION) {
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
  const rejectedKcUals = new Set<string>(parsed.invalidKcUals);
  const graphVerification = new Map<string, boolean>();
  const verifiedGraphScopedDataGraphs = new Set<string>();
  let verifiedZeroPublicAssets = 0;
  let fatalUnscopedFailure = parsed.fatalUnscopedFailure;
  const logs = [...parsed.logs];

  for (const candidate of graphScopedCandidates) {
    const { ual, descriptor } = candidate;
    // Changelog records serialize the complete shared metadata graph but only
    // the assertion graphs changed in this page. Unchanged descriptors remain
    // structurally parseable, but their peer-supplied rows are not selected
    // without the corresponding payload. Full snapshots verify every graph.
    if (
      mode.kind === 'changelogPage'
      && !mode.changedDataGraphs.has(descriptor.assertionGraph)
    ) {
      // The shared metadata record includes descriptors for unchanged assets.
      // They are structurally valid but not authenticated by this page's
      // payload, so never select their peer-supplied rows for replacement.
      // System graphs retain their explicit unverified-data override.
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
  const rejectedKcUals = new Set<string>();
  let fatalUnscopedFailure = false;
  const logs: DurableIntegrityLogEntry[] = [];

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
    rejectedKcUals,
    kaToKc,
    kcRootEntities,
    fatalUnscopedFailure,
    logs,
  };
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
    if (outcome.hasGraphScopedCandidates) unboundDataTriples += 1;
    else dataIndexes.push(index); // quarantined legacy compatibility
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
    return {
      dataIndexes: allIndexes(dataQuads),
      metaIndexes: allIndexes(metaQuads),
      rejected: 0,
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
      verifiedZeroPublicAssets: outcome.verifiedZeroPublicAssets,
      verifiedGraphScopedDataGraphs,
      logs,
    };
  }

  const metaIndexes: number[] = [];
  for (let index = 0; index < metaQuads.length; index++) {
    const quad = metaQuads[index]!;
    if (
      metadata.merkleSubjects.has(quad.subject)
      || metadata.markerSubjects.has(quad.subject)
    ) {
      if (outcome.admittedMetadataUals.has(quad.subject)) metaIndexes.push(index);
      continue;
    }
    const owner = outcome.kaToKc.get(quad.subject);
    if (!owner || outcome.admittedMetadataUals.has(owner)) metaIndexes.push(index);
  }

  return {
    dataIndexes,
    metaIndexes,
    rejected,
    verifiedZeroPublicAssets: outcome.verifiedZeroPublicAssets,
    verifiedGraphScopedDataGraphs,
    logs,
  };
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

function parseGraphScopedDescriptor(ual: string, rows: readonly Quad[]): GraphScopedDescriptor {
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

  return {
    ual,
    assertionGraph,
    publicTripleCount,
    privateRoot: privateRootValues[0]
      ? hexToBytes(normalizeHex32(privateRootValues[0], 'privateMerkleRoot'))
      : undefined,
    claimedRootHex: normalizeHex32(requireSingle(MERKLE_ROOT, 'merkleRoot'), 'merkleRoot'),
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
