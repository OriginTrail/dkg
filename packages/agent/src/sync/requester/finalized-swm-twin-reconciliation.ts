import {
  MemoryLayer,
  assertSafeIri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
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

const DKG = 'http://dkg.io/ontology/';

export type FinalizedSwmTwinReconciliationOutcome =
  | 'retired'
  | 'absent'
  | 'head-missing-or-ambiguous'
  | 'head-version-mismatch'
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
    const head = await readExactSwmHead(params.store, {
      metaGraph: evidence.swmMetaGraph,
      headSubject: evidence.headSubject,
    });
    if (head === null) return 'head-missing-or-ambiguous';
    if (head.version !== evidence.assertionVersion) return 'head-version-mismatch';
    if (head.kaUal !== evidence.kaUal || head.assertionGraph !== evidence.swmGraph) {
      return 'head-missing-or-ambiguous';
    }

    // Probe VM first. Most SWM snapshots are legitimately unfinalized, so
    // their VM graph is empty; avoid reading and hashing every full SWM graph
    // in that overwhelmingly common case. Both reads remain inside the lock.
    const vmQuads = await readExactGraph(params.store, evidence.vmGraph);
    const vmDigest = workspacePublicQuadsDigest(vmQuads);
    if (vmDigest !== evidence.expectedVmDigest) return 'vm-changed';
    const swmQuads = await readExactGraph(params.store, evidence.swmGraph);
    if (swmQuads.length === 0) return 'absent';
    if (workspacePublicQuadsDigest(swmQuads) !== vmDigest) return 'content-mismatch';

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
  const root = `did:dkg:context-graph:${asset.contextGraphId}`;
  const boundary = '/_verifiable_memory/';
  const boundaryIndex = asset.assertionGraph.lastIndexOf(boundary);
  if (boundaryIndex < 0) {
    throw new Error(`Authenticated VM graph has no verifiable-memory boundary: ${asset.assertionGraph}`);
  }
  const graphScope = asset.assertionGraph.slice(0, boundaryIndex);
  let subGraphName: string | undefined;
  if (graphScope !== root) {
    if (!graphScope.startsWith(`${root}/`)) {
      throw new Error(`Authenticated VM graph is outside context graph ${asset.contextGraphId}`);
    }
    subGraphName = graphScope.slice(root.length + 1);
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
  const swmMetaGraph = subGraphName
    ? `${root}/${subGraphName}/_shared_memory_meta`
    : `${root}/_shared_memory_meta`;
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

async function readExactSwmHead(
  store: TripleStore,
  input: Readonly<{ metaGraph: string; headSubject: string }>,
): Promise<Readonly<{
  version: bigint;
  kaUal: string;
  assertionGraph: string;
}> | null> {
  const result = await store.query(
    `SELECT DISTINCT ?version ?kaUal ?assertionGraph WHERE { `
    + `GRAPH <${assertSafeIri(input.metaGraph)}> { `
    + `<${assertSafeIri(input.headSubject)}> <${DKG}assertionVersion> ?version ; `
    + `<${DKG}kaUal> ?kaUal ; <${DKG}assertionGraph> ?assertionGraph } }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readHead' },
  );
  if (result.type !== 'bindings' || result.bindings.length !== 1) return null;
  const row = result.bindings[0]!;
  const version = parseInteger(row['version']);
  const kaUal = row['kaUal'];
  const assertionGraph = row['assertionGraph'];
  if (version === null || !kaUal || !assertionGraph) return null;
  return { version, kaUal, assertionGraph };
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
