import {
  MemoryLayer,
  assertSafeIri,
  contextGraphSharedMemoryMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  sparqlString,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import {
  invalidateSwmMaterializationWitness,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import { ethers } from 'ethers';

const DKG = 'http://dkg.io/ontology/';

export type FinalizedSwmTwinReconciliationOutcome =
  | 'retired'
  | 'already-retired-finalized'
  | 'head-missing-or-ambiguous'
  | 'head-version-mismatch'
  | 'vm-metadata-mismatch'
  | 'swm-commitment-mismatch'
  | 'vm-changed'
  | 'content-mismatch';

export interface FinalizedSwmTwinRetirement {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly kaUal: string;
  readonly swmGraph: string;
  readonly agentAddress: string;
  readonly kaNumber: bigint;
}

export interface FinalizedSwmTwinCatalogProjectionEvidence {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  /** Digest of the exact verified catalog projection activated into SWM. */
  readonly publicQuadsDigest: string;
  readonly publicQuadsCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
  /** Author-signed assertion root carried by the verified catalog seal. */
  readonly expectedMerkleRoot: string;
}

/**
 * Retire the mutable SWM twin of an authenticated VM asset, but only when the
 * receiver can prove locally that it is the exact finalized content.
 *
 * Durable VM catch-up does not pass through the live-finalization cleanup
 * boundary. Before this reconciliation, a receiver could therefore retain the
 * same KA in both `/_shared_memory/` and `/_verifiable_memory/` indefinitely.
 * The check is deliberately fail closed:
 *
 *  - the VM URI must be the canonical graph for the authenticated UAL/version;
 *  - the SWM head must name that exact graph and assertion version;
 *  - current VM bytes must still equal the just-authenticated payload; and
 *  - current SWM bytes must equal current VM bytes.
 *
 * The whole proof and retirement run under the same per-KA lock as gossip and
 * SWM snapshot materialization. A newer SWM version cannot land between the
 * comparison and deletion.
 */
export async function reconcileFinalizedSwmTwin(params: {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly asset: VerifiedGraphScopedAsset;
  readonly retire: (retirement: FinalizedSwmTwinRetirement) => Promise<void>;
}): Promise<FinalizedSwmTwinReconciliationOutcome> {
  const evidence = evidenceFromVmAsset(params.asset);
  return reconcileFinalizedSwmTwinEvidence({
    store: params.store,
    writeLocks: params.writeLocks,
    evidence,
    retire: params.retire,
  });
}

/**
 * Symmetric reconciliation for the opposite arrival order: SWM catch-up can
 * materialize a verified snapshot after VM recovery has already committed the
 * finalized graph. The descriptor is authenticated by the SWM parser and its
 * count/digest-bound snapshot materializer; this function still re-reads both
 * local graphs and the current head under the per-KA lock before deletion.
 */
export async function reconcileFinalizedSwmTwinFromDescriptor(params: {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly contextGraphId: string;
  readonly descriptor: GraphScopedSwmRecoveryDescriptor;
  readonly retire: (retirement: FinalizedSwmTwinRetirement) => Promise<void>;
}): Promise<FinalizedSwmTwinReconciliationOutcome> {
  const evidence = evidenceFromSwmDescriptor(params.contextGraphId, params.descriptor);
  return reconcileFinalizedSwmTwinEvidence({
    store: params.store,
    writeLocks: params.writeLocks,
    evidence,
    retire: params.retire,
  });
}

/**
 * Catalog activation can be the final SWM arrival even when a confirmed VM
 * copy already exists locally. Unlike ordinary SWM recovery, that path does
 * not create a WorkspaceOperation descriptor, so it supplies the equivalent
 * process-local proof directly: exact verified projection digest/count plus
 * the author-signed private and aggregate commitments from the catalog seal.
 */
export async function reconcileFinalizedSwmTwinFromCatalogProjection(params: {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly evidence: Readonly<FinalizedSwmTwinCatalogProjectionEvidence>;
  readonly retire: (retirement: FinalizedSwmTwinRetirement) => Promise<void>;
}): Promise<FinalizedSwmTwinReconciliationOutcome> {
  const evidence = evidenceFromCatalogProjection(params.evidence);
  return reconcileFinalizedSwmTwinEvidence({
    store: params.store,
    writeLocks: params.writeLocks,
    evidence,
    retire: params.retire,
  });
}

interface CommonFinalizedSwmTwinEvidence extends FinalizedSwmTwinRetirement {
  readonly assertionVersion: bigint;
  readonly vmGraph: string;
  readonly vmMetaGraph: string;
  readonly swmMetaGraph: string;
  readonly headSubject: string;
  readonly expectedVmDigest: string;
  readonly expectedPublicQuadsCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
}

interface VmArrivalFinalizedSwmTwinEvidence extends CommonFinalizedSwmTwinEvidence {
  /** VM catch-up authenticated this exact finalized root before reconciliation. */
  readonly arrival: 'vm';
  readonly expectedMerkleRoot: string;
}

interface SwmArrivalFinalizedSwmTwinEvidence extends CommonFinalizedSwmTwinEvidence {
  /** SWM materialization supplied the descriptor; current VM state is re-proved locally. */
  readonly arrival: 'swm';
}

interface CatalogArrivalFinalizedSwmTwinEvidence extends CommonFinalizedSwmTwinEvidence {
  /** Exact catalog projection plus author seal supplied the SWM evidence. */
  readonly arrival: 'catalog';
  readonly expectedMerkleRoot: string;
}

type FinalizedSwmTwinEvidence =
  | VmArrivalFinalizedSwmTwinEvidence
  | SwmArrivalFinalizedSwmTwinEvidence
  | CatalogArrivalFinalizedSwmTwinEvidence;

async function reconcileFinalizedSwmTwinEvidence(params: {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly evidence: FinalizedSwmTwinEvidence;
  readonly retire: (retirement: FinalizedSwmTwinRetirement) => Promise<void>;
}): Promise<FinalizedSwmTwinReconciliationOutcome> {
  const { evidence } = params;
  const lockKey = swmKaWriteLockKey(
    evidence.contextGraphId,
    evidence.subGraphName,
    evidence.kaUal,
  );

  return withKeyedLocks(params.writeLocks, [lockKey], async () => {
    // A public-byte match alone is insufficient: VM graph names are stable
    // across assertion versions and a private-only update can preserve every
    // public quad. Require the current VM control plane to prove the exact
    // confirmed assertion and private commitment before considering deletion.
    const vmQuads = await readExactGraph(params.store, evidence.vmGraph);
    const vmDigest = workspacePublicQuadsDigest(vmQuads);
    if (vmDigest !== evidence.expectedVmDigest) return 'vm-changed';
    const vmMetadata = await readExactVmMetadata(params.store, evidence);
    if (!vmMetadataMatchesEvidence(vmMetadata, evidence, vmQuads)) {
      return 'vm-metadata-mismatch';
    }

    const head = await readExactSwmHead(params.store, {
      metaGraph: evidence.swmMetaGraph,
      headSubject: evidence.headSubject,
    });
    if (head === null) {
      // Only the post-SWM-materialization call can interpret a missing head as
      // terminal. At that call site the descriptor and graph were just written
      // under the same KA lock; a missing head here means a concurrent VM-first
      // reconciliation completed after that lock was released. Suppressing the
      // outer bulk metadata append prevents resurrection of a dangling head.
      if (evidence.arrival === 'vm') return 'head-missing-or-ambiguous';
      const swmQuads = await readExactGraph(params.store, evidence.swmGraph);
      if (swmQuads.length === 0) return 'already-retired-finalized';
      if (workspacePublicQuadsDigest(swmQuads) !== vmDigest) return 'content-mismatch';
      await retireAndInvalidate(params, evidence);
      return 'retired';
    }
    if (head.version !== evidence.assertionVersion) return 'head-version-mismatch';
    if (head.kaUal !== evidence.kaUal || head.assertionGraph !== evidence.swmGraph) {
      return 'head-missing-or-ambiguous';
    }
    const swmCommitment = await readExactSwmOperationCommitment(
      params.store,
      evidence,
      head.shareOperationId,
    );
    if (!swmCommitmentMatchesEvidence(swmCommitment, evidence)) {
      return 'swm-commitment-mismatch';
    }
    const swmQuads = await readExactGraph(params.store, evidence.swmGraph);
    // Retirement drops the SWM graph before its metadata. If that second step
    // failed, re-enter the idempotent retirement callback to finish metadata
    // cleanup instead of permanently returning early on an absent graph.
    if (swmQuads.length === 0) {
      await retireAndInvalidate(params, evidence);
      return 'retired';
    }
    if (workspacePublicQuadsDigest(swmQuads) !== vmDigest) return 'content-mismatch';
    await retireAndInvalidate(params, evidence);
    return 'retired';
  });
}

async function retireAndInvalidate(
  params: {
    readonly store: TripleStore;
    readonly retire: (retirement: FinalizedSwmTwinRetirement) => Promise<void>;
  },
  evidence: FinalizedSwmTwinEvidence,
): Promise<void> {
  await params.retire(evidence);
  await invalidateSwmMaterializationWitness(params.store, evidence.swmGraph, {
    priority: 'background',
    source: 'agent.durableSync.finalizedSwmTwin.witnessInvalidate',
  }).catch(() => {});
}

function evidenceFromVmAsset(asset: VerifiedGraphScopedAsset): VmArrivalFinalizedSwmTwinEvidence {
  const scope = createGraphKnowledgeAssetScope(asset.ual, asset.assertionVersion);
  const subGraphName = optionalMetadataLiteral(asset, `${DKG}subGraphName`);
  if (subGraphName !== undefined) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Authenticated VM graph has invalid subgraph: ${validation.reason}`);
  }
  const expectedVmGraph = knowledgeAssetLayerGraphUri(
    asset.contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    subGraphName,
  );
  if (asset.assertionGraph !== expectedVmGraph) {
    throw new Error(
      `Authenticated VM graph mismatch: expected ${expectedVmGraph}, found ${asset.assertionGraph}`,
    );
  }
  const swmGraph = knowledgeAssetLayerGraphUri(
    asset.contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
    subGraphName,
  );
  const swmMetaGraph = contextGraphSharedMemoryMetaUri(asset.contextGraphId, subGraphName);
  const expectedPublicQuadsCount = requiredMetadataCount(asset, `${DKG}publicTripleCount`);
  const privateTripleCount = requiredMetadataCount(asset, `${DKG}privateTripleCount`);
  const privateMerkleRoot = optionalMetadataHex32(asset, `${DKG}privateMerkleRoot`);
  if ((privateTripleCount > 0) !== (privateMerkleRoot !== undefined)) {
    throw new Error('Authenticated VM metadata has an inconsistent private commitment');
  }
  const expectedMerkleRoot = requiredMetadataHex32(asset, `${DKG}merkleRoot`);
  if (optionalMetadataLiteral(asset, `${DKG}status`) !== 'confirmed') {
    throw new Error('Authenticated VM metadata is not confirmed');
  }
  return {
    arrival: 'vm',
    contextGraphId: asset.contextGraphId,
    ...(subGraphName === undefined ? {} : { subGraphName }),
    kaUal: asset.ual,
    assertionVersion: asset.assertionVersion,
    vmGraph: asset.assertionGraph,
    vmMetaGraph: asset.metaGraph,
    swmGraph,
    swmMetaGraph,
    headSubject: `${asset.ual}#dkg-swm-head`,
    expectedVmDigest: workspacePublicQuadsDigest(asset.dataQuads),
    expectedPublicQuadsCount,
    privateTripleCount,
    ...(privateMerkleRoot === undefined ? {} : { privateMerkleRoot }),
    expectedMerkleRoot,
    agentAddress: scope.agentAddress,
    kaNumber: BigInt(scope.kaNumber),
  };
}

function evidenceFromSwmDescriptor(
  contextGraphId: string,
  descriptor: GraphScopedSwmRecoveryDescriptor,
): SwmArrivalFinalizedSwmTwinEvidence {
  const scope = createGraphKnowledgeAssetScope(
    descriptor.kaUal,
    descriptor.assertionVersion,
  );
  const expectedSwmGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
    descriptor.subGraphName,
  );
  if (descriptor.assertionGraph !== expectedSwmGraph) {
    throw new Error(
      `Authenticated SWM graph mismatch: expected ${expectedSwmGraph}, found ${descriptor.assertionGraph}`,
    );
  }
  const vmGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    descriptor.subGraphName,
  );
  return {
    arrival: 'swm',
    contextGraphId,
    ...(descriptor.subGraphName === undefined
      ? {}
      : { subGraphName: descriptor.subGraphName }),
    kaUal: descriptor.kaUal,
    assertionVersion: BigInt(descriptor.assertionVersion),
    vmGraph,
    vmMetaGraph: `did:dkg:context-graph:${contextGraphId}/_meta`,
    swmGraph: descriptor.assertionGraph,
    swmMetaGraph: descriptor.metaGraph,
    headSubject: descriptor.headSubject,
    expectedVmDigest: descriptor.publicQuadsDigest,
    expectedPublicQuadsCount: descriptor.publicQuadsCount,
    privateTripleCount: descriptor.privateTripleCount,
    ...(descriptor.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: normalizeHex32(descriptor.privateMerkleRoot) }),
    agentAddress: scope.agentAddress,
    kaNumber: BigInt(scope.kaNumber),
  };
}

function evidenceFromCatalogProjection(
  input: Readonly<FinalizedSwmTwinCatalogProjectionEvidence>,
): CatalogArrivalFinalizedSwmTwinEvidence {
  const scope = createGraphKnowledgeAssetScope(input.kaUal, input.assertionVersion);
  const swmGraph = knowledgeAssetLayerGraphUri(
    input.contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
    input.subGraphName,
  );
  const vmGraph = knowledgeAssetLayerGraphUri(
    input.contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    input.subGraphName,
  );
  return {
    arrival: 'catalog',
    contextGraphId: input.contextGraphId,
    ...(input.subGraphName === undefined ? {} : { subGraphName: input.subGraphName }),
    kaUal: scope.ual,
    assertionVersion: BigInt(input.assertionVersion),
    vmGraph,
    vmMetaGraph: `did:dkg:context-graph:${input.contextGraphId}/_meta`,
    swmGraph,
    swmMetaGraph: contextGraphSharedMemoryMetaUri(
      input.contextGraphId,
      input.subGraphName,
    ),
    headSubject: `${scope.ual}#dkg-swm-head`,
    expectedVmDigest: input.publicQuadsDigest.trim().toLowerCase(),
    expectedPublicQuadsCount: input.publicQuadsCount,
    privateTripleCount: input.privateTripleCount,
    ...(input.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: normalizeHex32(input.privateMerkleRoot) }),
    expectedMerkleRoot: normalizeHex32(input.expectedMerkleRoot),
    agentAddress: scope.agentAddress,
    kaNumber: BigInt(scope.kaNumber),
  };
}

interface ExactVmMetadata {
  readonly assertionVersion: bigint;
  readonly assertionGraph: string;
  readonly status: string;
  readonly publicTripleCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly merkleRoot: string;
}

async function readExactVmMetadata(
  store: TripleStore,
  evidence: FinalizedSwmTwinEvidence,
): Promise<ExactVmMetadata | null> {
  const result = await store.query(
    `SELECT DISTINCT ?assertionVersion ?assertionGraph ?status ?publicTripleCount `
    + `?privateTripleCount ?privateMerkleRoot ?merkleRoot WHERE { `
    + `GRAPH <${assertSafeIri(evidence.vmMetaGraph)}> { `
    + `<${assertSafeIri(evidence.kaUal)}> <${DKG}assertionVersion> ?assertionVersion ; `
    + `<${DKG}assertionGraph> ?assertionGraph ; <${DKG}status> ?status ; `
    + `<${DKG}publicTripleCount> ?publicTripleCount ; `
    + `<${DKG}privateTripleCount> ?privateTripleCount ; <${DKG}merkleRoot> ?merkleRoot . `
    + `OPTIONAL { <${assertSafeIri(evidence.kaUal)}> <${DKG}privateMerkleRoot> ?privateMerkleRoot } `
    + `} }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readVmMetadata' },
  );
  if (result.type !== 'bindings' || result.bindings.length !== 1) return null;
  const row = result.bindings[0]!;
  const assertionVersion = parseInteger(row['assertionVersion']);
  const assertionGraph = row['assertionGraph'];
  const status = literalValue(row['status']);
  const publicTripleCount = parseSafeCount(row['publicTripleCount']);
  const privateTripleCount = parseSafeCount(row['privateTripleCount']);
  const privateMerkleRoot = optionalHex32(row['privateMerkleRoot']);
  const merkleRoot = optionalHex32(row['merkleRoot']);
  if (
    assertionVersion === null
    || !assertionGraph
    || status === undefined
    || publicTripleCount === null
    || privateTripleCount === null
    || merkleRoot === undefined
    || ((privateTripleCount > 0) !== (privateMerkleRoot !== undefined))
  ) return null;
  return {
    assertionVersion,
    assertionGraph,
    status,
    publicTripleCount,
    privateTripleCount,
    ...(privateMerkleRoot === undefined ? {} : { privateMerkleRoot }),
    merkleRoot,
  };
}

function vmMetadataMatchesEvidence(
  metadata: ExactVmMetadata | null,
  evidence: FinalizedSwmTwinEvidence,
  vmQuads: readonly Quad[],
): boolean {
  if (
    metadata === null
    || metadata.status !== 'confirmed'
    || metadata.assertionVersion !== evidence.assertionVersion
    || metadata.assertionGraph !== evidence.vmGraph
    || metadata.publicTripleCount !== evidence.expectedPublicQuadsCount
    || metadata.publicTripleCount !== vmQuads.length
    || metadata.privateTripleCount !== evidence.privateTripleCount
    || metadata.privateMerkleRoot !== evidence.privateMerkleRoot
  ) return false;
  const privateRoots = evidence.privateMerkleRoot === undefined
    ? []
    : [ethers.getBytes(evidence.privateMerkleRoot)];
  const computedMerkleRoot = ethers.hexlify(computeFlatKCRootV10([...vmQuads], privateRoots)).toLowerCase();
  return metadata.merkleRoot === computedMerkleRoot
    && (evidence.arrival === 'swm'
      || evidence.expectedMerkleRoot === computedMerkleRoot);
}

interface ExactSwmOperationCommitment {
  readonly kaUal: string;
  readonly assertionVersion: bigint;
  readonly publicQuadsDigest: string;
  readonly publicQuadsCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
}

async function readExactSwmOperationCommitment(
  store: TripleStore,
  evidence: FinalizedSwmTwinEvidence,
  shareOperationId: string,
): Promise<ExactSwmOperationCommitment | null> {
  const operationSubject = `urn:dkg:share:${evidence.contextGraphId}:${shareOperationId}`;
  const result = await store.query(
    `SELECT DISTINCT ?kaUal ?assertionVersion ?publicQuadsDigest ?publicQuadsCount `
    + `?privateTripleCount ?privateMerkleRoot WHERE { `
    + `GRAPH <${assertSafeIri(evidence.swmMetaGraph)}> { `
    + `<${assertSafeIri(operationSubject)}> <${DKG}shareOperationId> ?shareOperationId ; `
    + `<${DKG}kaUal> ?kaUal ; <${DKG}assertionVersion> ?assertionVersion ; `
    + `<${DKG}publicQuadsDigest> ?publicQuadsDigest ; `
    + `<${DKG}publicQuadsCount> ?publicQuadsCount ; `
    + `<${DKG}privateTripleCount> ?privateTripleCount . `
    + `OPTIONAL { <${assertSafeIri(operationSubject)}> <${DKG}privateMerkleRoot> ?privateMerkleRoot } `
    + `FILTER(STR(?shareOperationId) = ${sparqlString(shareOperationId)}) `
    + `} }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readSwmCommitment' },
  );
  if (result.type !== 'bindings' || result.bindings.length !== 1) return null;
  const row = result.bindings[0]!;
  const assertionVersion = parseInteger(row['assertionVersion']);
  const publicQuadsDigest = literalValue(row['publicQuadsDigest'])?.trim().toLowerCase();
  const publicQuadsCount = parseSafeCount(row['publicQuadsCount']);
  const privateTripleCount = parseSafeCount(row['privateTripleCount']);
  const privateMerkleRoot = optionalHex32(row['privateMerkleRoot']);
  if (
    assertionVersion === null
    || !row['kaUal']
    || !publicQuadsDigest
    || publicQuadsCount === null
    || privateTripleCount === null
    || ((privateTripleCount > 0) !== (privateMerkleRoot !== undefined))
  ) return null;
  return {
    kaUal: row['kaUal'],
    assertionVersion,
    publicQuadsDigest,
    publicQuadsCount,
    privateTripleCount,
    ...(privateMerkleRoot === undefined ? {} : { privateMerkleRoot }),
  };
}

function swmCommitmentMatchesEvidence(
  commitment: ExactSwmOperationCommitment | null,
  evidence: FinalizedSwmTwinEvidence,
): boolean {
  return commitment !== null
    && commitment.kaUal === evidence.kaUal
    && commitment.assertionVersion === evidence.assertionVersion
    && commitment.publicQuadsDigest === evidence.expectedVmDigest
    && commitment.publicQuadsCount === evidence.expectedPublicQuadsCount
    && commitment.privateTripleCount === evidence.privateTripleCount
    && commitment.privateMerkleRoot === evidence.privateMerkleRoot;
}

function metadataObjects(asset: VerifiedGraphScopedAsset, predicate: string): string[] {
  return asset.metadataQuads
    .filter((quad) => (
      quad.graph === asset.metaGraph
      && quad.subject === asset.ual
      && quad.predicate === predicate
    ))
    .map((quad) => quad.object);
}

function optionalMetadataLiteral(
  asset: VerifiedGraphScopedAsset,
  predicate: string,
): string | undefined {
  const values = metadataObjects(asset, predicate);
  if (values.length > 1) throw new Error(`Authenticated VM metadata has ambiguous ${predicate}`);
  return values[0] === undefined ? undefined : literalValue(values[0]);
}

function requiredMetadataCount(asset: VerifiedGraphScopedAsset, predicate: string): number {
  const values = metadataObjects(asset, predicate);
  if (values.length !== 1) throw new Error(`Authenticated VM metadata has non-unique ${predicate}`);
  const value = parseSafeCount(values[0]);
  if (value === null) throw new Error(`Authenticated VM metadata has invalid ${predicate}`);
  return value;
}

function optionalMetadataHex32(
  asset: VerifiedGraphScopedAsset,
  predicate: string,
): string | undefined {
  const values = metadataObjects(asset, predicate);
  if (values.length > 1) throw new Error(`Authenticated VM metadata has ambiguous ${predicate}`);
  return optionalHex32(values[0]);
}

function requiredMetadataHex32(asset: VerifiedGraphScopedAsset, predicate: string): string {
  const value = optionalMetadataHex32(asset, predicate);
  if (value === undefined) throw new Error(`Authenticated VM metadata has invalid ${predicate}`);
  return value;
}

async function readExactGraph(store: TripleStore, graph: string): Promise<Quad[]> {
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o } }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readGraph' },
  );
  // The persistent Oxigraph worker reports an empty CONSTRUCT as the generic
  // zero-row bindings shape, while the in-process adapter reports `quads: []`.
  // Accept only that exact empty compatibility shape; non-empty bindings stay
  // fail-closed because converting them would lose RDF term identity.
  if (result.type === 'bindings' && result.bindings.length === 0) return [];
  if (result.type !== 'quads') {
    throw new Error(`Unexpected exact-graph query result for ${graph}: ${result.type}`);
  }
  return result.quads.map((quad) => ({ ...quad, graph: '' }));
}

async function readExactSwmHead(
  store: TripleStore,
  input: Readonly<{ metaGraph: string; headSubject: string }>,
): Promise<Readonly<{
  version: bigint;
  kaUal: string;
  assertionGraph: string;
  shareOperationId: string;
}> | null> {
  const result = await store.query(
    `SELECT DISTINCT ?version ?kaUal ?assertionGraph ?shareOperationId WHERE { `
    + `GRAPH <${assertSafeIri(input.metaGraph)}> { `
    + `<${assertSafeIri(input.headSubject)}> <${DKG}assertionVersion> ?version ; `
    + `<${DKG}kaUal> ?kaUal ; <${DKG}assertionGraph> ?assertionGraph ; `
    + `<${DKG}shareOperationId> ?shareOperationId } }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readHead' },
  );
  if (result.type !== 'bindings' || result.bindings.length !== 1) return null;
  const row = result.bindings[0]!;
  const version = parseInteger(row['version']);
  const kaUal = row['kaUal'];
  const assertionGraph = row['assertionGraph'];
  const shareOperationId = literalValue(row['shareOperationId'])?.trim();
  if (version === null || !kaUal || !assertionGraph || !shareOperationId) return null;
  return { version, kaUal, assertionGraph, shareOperationId };
}

function parseInteger(value: string | undefined): bigint | null {
  if (!value) return null;
  const match = /^"?([0-9]+)"?(?:\^\^<[^>]+>)?$/.exec(value);
  if (!match?.[1]) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

function parseSafeCount(value: string | undefined): number | null {
  const parsed = parseInteger(value);
  if (parsed === null || parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

function literalValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^<[^>]+>|@[A-Za-z0-9-]+)?$/.exec(value);
  return match?.[1] ?? value;
}

function normalizeHex32(value: string): string {
  const raw = literalValue(value)?.trim().replace(/^0x/i, '').toLowerCase();
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) throw new Error('Expected a 32-byte hexadecimal value');
  return `0x${raw}`;
}

function optionalHex32(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeHex32(value);
  } catch {
    return undefined;
  }
}
