import {
  MemoryLayer,
  assertSafeIri,
  contextGraphSharedMemoryMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  parseContextGraphLayerUri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
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
import {
  parseGraphScopedSwmRecoveryDescriptors,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';

const DKG = 'http://dkg.io/ontology/';

export type FinalizedSwmTwinReconciliationOutcome =
  | 'retired'
  | 'already-retired'
  | 'head-missing-or-ambiguous'
  | 'head-version-mismatch'
  | 'vm-changed'
  | 'vm-metadata-mismatch'
  | 'commitment-mismatch'
  | 'content-mismatch';

export interface FinalizedSwmTwinRetirement {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly kaUal: string;
  readonly swmGraph: string;
  readonly agentAddress: string;
  readonly kaNumber: bigint;
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

interface FinalizedSwmTwinEvidence extends FinalizedSwmTwinRetirement {
  readonly assertionVersion: bigint;
  readonly vmGraph: string;
  readonly swmMetaGraph: string;
  readonly headSubject: string;
  readonly expectedVmDigest: string;
  readonly expectedPublicQuadsCount: number;
  readonly expectedSwmOperation?: Readonly<{
    shareOperationId: string;
    publicQuadsDigest: string;
    publicQuadsCount: number;
    privateTripleCount: number;
    privateMerkleRoot?: string;
  }>;
}

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
    // The VM graph URI is version-independent, so bytes alone cannot prove
    // which assertion they belong to. Re-read the canonical confirmed envelope
    // inside the same proof boundary and bind those bytes to exact current VM
    // version, graph, public count, private commitment, and Merkle root.
    const currentVm = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(
      params.store,
      { contextGraphId: evidence.contextGraphId, ual: evidence.kaUal },
    );
    if (currentVm.state !== 'confirmed') return 'vm-metadata-mismatch';
    const vmMetadata = currentVm.envelope;
    if (
      BigInt(vmMetadata.assertionVersion) !== evidence.assertionVersion
      || vmMetadata.assertionGraph !== evidence.vmGraph
      || vmMetadata.subGraphName !== evidence.subGraphName
      || vmMetadata.publicTripleCount !== evidence.expectedPublicQuadsCount
    ) {
      return 'vm-metadata-mismatch';
    }
    const expectedOperation = evidence.expectedSwmOperation;
    if (expectedOperation && !privateCommitmentsEqual(expectedOperation, vmMetadata)) {
      return 'commitment-mismatch';
    }

    const vmQuads = await readExactGraph(params.store, evidence.vmGraph);
    const vmDigest = workspacePublicQuadsDigest(vmQuads);
    if (
      vmQuads.length !== vmMetadata.publicTripleCount
      || vmDigest !== evidence.expectedVmDigest
    ) {
      return 'vm-changed';
    }
    const computedVmRoot = computeFlatKCRootV10(
      vmQuads,
      vmMetadata.privateMerkleRoot ? [vmMetadata.privateMerkleRoot] : [],
    );
    if (!bytesEqual(computedVmRoot, vmMetadata.merkleRoot)) {
      return 'vm-metadata-mismatch';
    }

    const currentHead = await readCanonicalSwmHead(params.store, evidence);
    if (currentHead.state === 'invalid') return 'head-missing-or-ambiguous';
    if (currentHead.state === 'absent') {
      // A competing finalized-twin cleanup can win after snapshot
      // materialization releases the lock. Only classify that state as already
      // retired when both the canonical head and exact SWM graph are gone;
      // callers may then suppress a stale bulk metadata replay.
      const remainingSwm = await readExactGraph(params.store, evidence.swmGraph);
      if (remainingSwm.length > 0) return 'head-missing-or-ambiguous';
      // Retirement is idempotent and discovers operation rows by exact KA UAL,
      // not through the now-missing head. Re-run it to finish a failure that
      // deleted graph/head but left operation metadata behind.
      await params.retire(evidence);
      await invalidateSwmMaterializationWitness(params.store, evidence.swmGraph, {
        priority: 'background',
        source: 'agent.durableSync.finalizedSwmTwin.witnessInvalidate',
      }).catch(() => {});
      return 'already-retired';
    }
    const head = currentHead.descriptor;
    if (BigInt(head.assertionVersion) !== evidence.assertionVersion) {
      return 'head-version-mismatch';
    }
    if (head.kaUal !== evidence.kaUal || head.assertionGraph !== evidence.swmGraph) {
      return 'head-missing-or-ambiguous';
    }
    if (
      head.publicQuadsDigest !== vmDigest
      || head.publicQuadsCount !== vmMetadata.publicTripleCount
      || !privateCommitmentsEqual(head, vmMetadata)
    ) {
      return 'commitment-mismatch';
    }
    if (expectedOperation && (
      head.shareOperationId !== expectedOperation.shareOperationId
      || head.publicQuadsDigest !== expectedOperation.publicQuadsDigest
      || head.publicQuadsCount !== expectedOperation.publicQuadsCount
      || !privateCommitmentsEqual(head, expectedOperation)
    )) {
      return 'head-missing-or-ambiguous';
    }

    const swmQuads = await readExactGraph(params.store, evidence.swmGraph);
    if (
      swmQuads.length > 0
      && (
        swmQuads.length !== vmMetadata.publicTripleCount
        || workspacePublicQuadsDigest(swmQuads) !== vmDigest
      )
    ) {
      return 'content-mismatch';
    }

    // `retire` is intentionally invoked even when the SWM graph is already
    // absent: production retirement drops graph(s) before metadata, so this is
    // the idempotent retry that completes a prior graph-first partial failure.
    await params.retire(evidence);
    await invalidateSwmMaterializationWitness(params.store, evidence.swmGraph, {
      priority: 'background',
      source: 'agent.durableSync.finalizedSwmTwin.witnessInvalidate',
    }).catch(() => {});
    return 'retired';
  });
}

function evidenceFromVmAsset(asset: VerifiedGraphScopedAsset): FinalizedSwmTwinEvidence {
  const scope = createGraphKnowledgeAssetScope(asset.ual, asset.assertionVersion);
  const parsed = parseContextGraphLayerUri(asset.assertionGraph);
  if (
    parsed === undefined
    || parsed.layer !== MemoryLayer.VerifiableMemory
    || parsed.contextGraphId !== asset.contextGraphId
    || parsed.agentAddress.toLowerCase() !== scope.agentAddress.toLowerCase()
    || parsed.kaNumber !== BigInt(scope.kaNumber)
  ) {
    throw new Error(`Authenticated VM graph identity mismatch: ${asset.assertionGraph}`);
  }
  const subGraphName = parsed.subGraphName;
  if (subGraphName !== undefined) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) {
      throw new Error(`Authenticated VM graph has invalid subgraph: ${validation.reason}`);
    }
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
  return {
    contextGraphId: asset.contextGraphId,
    ...(subGraphName === undefined ? {} : { subGraphName }),
    kaUal: asset.ual,
    assertionVersion: asset.assertionVersion,
    vmGraph: asset.assertionGraph,
    swmGraph,
    swmMetaGraph,
    headSubject: `${asset.ual}#dkg-swm-head`,
    expectedVmDigest: workspacePublicQuadsDigest(asset.dataQuads),
    expectedPublicQuadsCount: asset.dataQuads.length,
    agentAddress: scope.agentAddress,
    kaNumber: BigInt(scope.kaNumber),
  };
}

function evidenceFromSwmDescriptor(
  contextGraphId: string,
  descriptor: GraphScopedSwmRecoveryDescriptor,
): FinalizedSwmTwinEvidence {
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
    contextGraphId,
    ...(descriptor.subGraphName === undefined
      ? {}
      : { subGraphName: descriptor.subGraphName }),
    kaUal: descriptor.kaUal,
    assertionVersion: BigInt(descriptor.assertionVersion),
    vmGraph,
    swmGraph: descriptor.assertionGraph,
    swmMetaGraph: descriptor.metaGraph,
    headSubject: descriptor.headSubject,
    expectedVmDigest: descriptor.publicQuadsDigest,
    expectedPublicQuadsCount: descriptor.publicQuadsCount,
    expectedSwmOperation: {
      shareOperationId: descriptor.shareOperationId,
      publicQuadsDigest: descriptor.publicQuadsDigest,
      publicQuadsCount: descriptor.publicQuadsCount,
      privateTripleCount: descriptor.privateTripleCount,
      ...(descriptor.privateMerkleRoot
        ? { privateMerkleRoot: descriptor.privateMerkleRoot }
        : {}),
    },
    agentAddress: scope.agentAddress,
    kaNumber: BigInt(scope.kaNumber),
  };
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

type CanonicalSwmHeadRead =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'invalid' }>
  | Readonly<{ state: 'present'; descriptor: GraphScopedSwmRecoveryDescriptor }>;

async function readCanonicalSwmHead(
  store: TripleStore,
  evidence: FinalizedSwmTwinEvidence,
): Promise<CanonicalSwmHeadRead> {
  const result = await store.query(
    `CONSTRUCT { <${assertSafeIri(evidence.headSubject)}> ?headPredicate ?headObject . `
    + `?operation ?operationPredicate ?operationObject } WHERE { `
    + `GRAPH <${assertSafeIri(evidence.swmMetaGraph)}> { `
    + `<${assertSafeIri(evidence.headSubject)}> ?headPredicate ?headObject . `
    + `OPTIONAL { <${assertSafeIri(evidence.headSubject)}> <${DKG}shareOperationId> ?shareId . `
    + `?operation <${DKG}shareOperationId> ?shareId ; `
    + `<${DKG}kaUal> <${assertSafeIri(evidence.kaUal)}> ; `
    + `?operationPredicate ?operationObject } } }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readHead' },
  );
  if (result.type === 'bindings' && result.bindings.length === 0) {
    return { state: 'absent' };
  }
  if (result.type !== 'quads') {
    throw new Error(`Unexpected SWM head query result for ${evidence.kaUal}: ${result.type}`);
  }
  if (result.quads.length === 0) return { state: 'absent' };
  try {
    const descriptors = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: evidence.contextGraphId,
      metaQuads: result.quads.map((quad) => ({ ...quad, graph: evidence.swmMetaGraph })),
      ...(evidence.subGraphName === undefined
        ? {}
        : { registeredSubGraphNames: [evidence.subGraphName] }),
    });
    return descriptors.length === 1
      ? { state: 'present', descriptor: descriptors[0]! }
      : { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
}

function privateCommitmentsEqual(
  left: Readonly<{ privateTripleCount: number; privateMerkleRoot?: string | Uint8Array }>,
  right: Readonly<{ privateTripleCount: number; privateMerkleRoot?: string | Uint8Array }>,
): boolean {
  return left.privateTripleCount === right.privateTripleCount
    && normalizePrivateRoot(left.privateMerkleRoot) === normalizePrivateRoot(right.privateMerkleRoot);
}

function normalizePrivateRoot(value: string | Uint8Array | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.toLowerCase();
  return `0x${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
