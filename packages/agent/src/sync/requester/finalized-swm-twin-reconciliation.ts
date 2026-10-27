import { commitmentFromVmAsset, type FinalizedVmAssetCommitment } from './finalized-vm-asset-commitment.js';
import { parseInteger, parseSafeCount, literalValue, normalizeHex32, optionalHex32 } from './finalized-swm-twin-terms.js';
import {
  MemoryLayer,
  assertSafeIri,
  contextGraphSharedMemoryMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  sparqlString,
  validateSubGraphName,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  KnowledgeAssetWorkspaceHeadCorruptError,
  computeFlatKCRootV10,
  resolvePublishedKnowledgeAssetWorkspaceHead,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspaceKnowledgeAssetHeadSubject,
  workspacePublicQuadsDigest,
  type PublishedKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import {
  GraphManager,
  deleteByPatternWithoutCount,
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

export interface ConfirmedGraphScopedSwmOrphanCandidate {
  readonly contextGraphId: string;
  readonly ual: string;
  readonly agentAddress: string;
  readonly kaNumber: bigint;
  readonly assertionVersion: bigint;
  readonly subGraphName?: string;
}

export type RetireConfirmedGraphScopedSwmTwinIfOrphaned = (
  candidate: Readonly<ConfirmedGraphScopedSwmOrphanCandidate>,
  ctx: OperationContext,
) => Promise<void>;

/**
 * Build the single atomic boundary used by headless exact-VM recovery.
 * The owner captures publisher locks and cleanup mechanics so finalization
 * supplies policy only and can never accidentally select an unlocked mode.
 */
export function createRetireConfirmedGraphScopedSwmTwinIfOrphaned(params: {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly retire: RetireConfirmedGraphScopedSwmTwinIfOrphaned;
  /** Reports a torn head removed because the confirmed VM copy supersedes it. */
  readonly onTornHeadRemoved?: (message: string, ctx: OperationContext) => void;
}): RetireConfirmedGraphScopedSwmTwinIfOrphaned {
  const graphManager = new GraphManager(params.store);
  return async (candidate, ctx) => {
    const lockKey = swmKaWriteLockKey(
      candidate.contextGraphId,
      candidate.subGraphName,
      candidate.ual,
    );
    await withKeyedLocks(params.writeLocks, [lockKey], async () => {
      let currentHead: PublishedKnowledgeAssetWorkspaceHead | undefined;
      try {
        currentHead = await resolvePublishedKnowledgeAssetWorkspaceHead({
          store: params.store,
          graphManager,
          contextGraphId: candidate.contextGraphId,
          kaUal: candidate.ual,
          subGraphName: candidate.subGraphName,
        });
      } catch (error) {
        if (!(error instanceof KnowledgeAssetWorkspaceHeadCorruptError)) throw error;
        // A torn head that the verified VM copy supersedes is residue, not a
        // live SWM asset: remove it and retire the twin like a headless one.
        // Any other corrupt head stays in place for the caller to report.
        const removedVersion = await deleteSupersededTornHead(params.store, candidate);
        if (removedVersion === undefined) throw error;
        params.onTornHeadRemoved?.(
          `Removed torn graph-scoped SWM head for ${candidate.ual} (head version `
            + `${removedVersion}, no share operation) superseded by confirmed VM version `
            + `${candidate.assertionVersion}`,
          ctx,
        );
      }
      // Any current mutable head owns the stable per-KA SWM graph. Preserve it
      // regardless of version; the verified VM copy remains independently safe.
      if (currentHead !== undefined) return;
      await params.retire(candidate, ctx);
    });
  };
}

/**
 * Delete a torn SWM head the confirmed VM copy supersedes and return its
 * version, or `undefined` when the head is not provably that residue. Torn:
 * the head names no share operation, so no reader can resolve it and it owns
 * nothing. Superseded: it certifies exactly one assertion version, no newer
 * than the verified VM copy, so no unpublished SWM work can hide behind it.
 * The caller must hold the per-KA SWM write lock.
 */
async function deleteSupersededTornHead(
  store: TripleStore,
  candidate: Readonly<ConfirmedGraphScopedSwmOrphanCandidate>,
): Promise<bigint | undefined> {
  const metaGraph = contextGraphSharedMemoryMetaUri(
    candidate.contextGraphId,
    candidate.subGraphName?.trim() || undefined,
  );
  const headSubject = workspaceKnowledgeAssetHeadSubject(candidate.ual);
  const rows = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${assertSafeIri(metaGraph)}> { `
    + `<${assertSafeIri(headSubject)}> ?p ?o } }`,
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.readTornHead' },
  );
  if (rows.type !== 'bindings' || rows.bindings.length === 0) return undefined;
  const versions = new Set<bigint>();
  for (const row of rows.bindings) {
    if (row['p'] === `${DKG}shareOperationId`) return undefined;
    if (row['p'] !== `${DKG}assertionVersion`) continue;
    const version = parseInteger(row['o']);
    if (version === null) return undefined;
    versions.add(version);
  }
  const [version] = versions;
  if (
    versions.size !== 1
    || version === undefined
    || version < 1n
    || version > candidate.assertionVersion
  ) return undefined;
  await deleteByPatternWithoutCount(
    store,
    { graph: metaGraph, subject: headSubject },
    { priority: 'background', source: 'agent.durableSync.finalizedSwmTwin.deleteTornHead' },
  );
  return version;
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
  return reconcileFinalizedSwmTwinFromCommitment({
    store: params.store, writeLocks: params.writeLocks,
    commitment: commitmentFromVmAsset(params.asset), retire: params.retire,
  });
}

/** Held recovery retains this compact evidence under its live content fence. */
export async function reconcileFinalizedSwmTwinFromCommitment(params: {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly commitment: FinalizedVmAssetCommitment;
  readonly retire: (retirement: FinalizedSwmTwinRetirement) => Promise<void>;
}): Promise<FinalizedSwmTwinReconciliationOutcome> {
  return reconcileFinalizedSwmTwinEvidence({ ...params, evidence: evidenceFromVmCommitment(params.commitment) });
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
    // VM-first arrival has nothing to retire without an exact SWM head. Check
    // under the shared SWM write lock before rereading the complete VM payload;
    // a later SWM arrival runs its own symmetric reconciliation after commit.
    const vmArrivalHead = evidence.arrival === 'vm'
      ? await readExactSwmHead(params.store, {
          metaGraph: evidence.swmMetaGraph,
          headSubject: evidence.headSubject,
        })
      : undefined;
    if (vmArrivalHead === null) return 'head-missing-or-ambiguous';

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

    const head = vmArrivalHead ?? await readExactSwmHead(params.store, {
      metaGraph: evidence.swmMetaGraph,
      headSubject: evidence.headSubject,
    });
    if (head === null) {
      // Only the post-SWM-materialization call can interpret a missing head as
      // terminal. At that call site the descriptor and graph were just written
      // under the same KA lock; a missing head here means a concurrent VM-first
      // reconciliation completed after that lock was released. Suppressing the
      // outer bulk metadata append prevents resurrection of a dangling head.
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

function evidenceFromVmCommitment(asset: FinalizedVmAssetCommitment): VmArrivalFinalizedSwmTwinEvidence {
  const scope = createGraphKnowledgeAssetScope(asset.ual, asset.assertionVersion);
  const subGraphName = asset.subGraphName;
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
  const expectedPublicQuadsCount = asset.publicTripleCount;
  const privateTripleCount = asset.privateTripleCount;
  const privateMerkleRoot = asset.privateMerkleRoot === undefined ? undefined : normalizeHex32(asset.privateMerkleRoot);
  if ((privateTripleCount > 0) !== (privateMerkleRoot !== undefined)) {
    throw new Error('Authenticated VM metadata has an inconsistent private commitment');
  }
  const expectedMerkleRoot = normalizeHex32(asset.merkleRootHex);
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
    expectedVmDigest: asset.publicQuadsDigest,
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
