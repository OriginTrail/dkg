import { createGraphKnowledgeAssetScope, type GraphKnowledgeAssetAccessPolicy } from '@origintrail-official/dkg-core';
import { type TripleStore, type GraphManager, type Quad, type QueryOptions, invalidateSwmMaterializationWitness, deleteByPatternWithoutCount } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { ACKCommitSequence } from './ack-commit-sequence.js';
import { tryReplaceGraphWithDurableRootCompanionAtomically, type DurableRootAtomicCompanionResolver } from './durable-root-atomic-companion.js';
import { swmKaWriteLockKey, withKeyedLocks } from './keyed-lock.js';
import { generateKnowledgeAssetShareMetadata } from './metadata.js';
import { storageAckOperationId, type StorageAckLedgerEntry } from './storage-ack-ledger.js';
import { type StorageAckRequestContext } from './storage-ack-head-policy.js';
import { workspacePublicQuadsDigest } from './workspace-snapshot-store.js';
import { storeKnowledgeAssetWorkspaceHead } from './workspace-resolution.js';

/** The verified graph envelope stored by a core before it signs. */
export type GraphScopedAckCopy = {
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  accessPolicy?: GraphKnowledgeAssetAccessPolicy;
  allowedPeers?: string[];
  subGraphName?: string;
};

export type AckCopyHeadVerdict =
  | { readonly kind: 'decline'; readonly decline: Uint8Array }
  | { readonly kind: 'replace-head' | 'preserve-head'; readonly supersede: readonly string[] };

export interface GraphScopedACKPersistenceRequest {
  cgId: string;
  swmGraphId: string;
  swmGraphUri: string;
  graphPublish: GraphScopedAckCopy;
  parsed: Quad[];
  publisherPeerId: string;
  merkleRoot: Uint8Array;
  replaceGraph: boolean;
  signal?: AbortSignal;
  recordLedger: boolean;
  context: StorageAckRequestContext;
  digest: Uint8Array;
}

export type GraphScopedACKPersistenceResult =
  | { ok: true; signature: ethers.Signature }
  | { ok: false; decline: Uint8Array };

export interface GraphScopedACKPersistenceDependencies {
  store: TripleStore;
  graphManager: GraphManager;
  config: {
    workspaceWriteLocks?: Map<string, Promise<void>>;
    resolveDurableRootAtomicCompanion?: DurableRootAtomicCompanionResolver;
  };
  ports: {
    assertParsed(parsed: Quad[]): void;
    checkHead(input: {
      cgId: string;
      swmGraphId: string;
      scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
      subGraphName?: string;
      publicDigest: string;
      publicTripleCount: number;
      privateTripleCount: number;
      privateMerkleRoot?: string;
      publisherPeerId: string;
      context: StorageAckRequestContext;
      signal?: AbortSignal;
    }): Promise<AckCopyHeadVerdict>;
    runWhileLive<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
    runStoreOpOrDecline<T>(cgId: string, work: () => Promise<T>, signal?: AbortSignal):
      Promise<{ ok: true; value: T } | { ok: false; decline: Uint8Array }>;
    signDigest(digest: Uint8Array, signal?: AbortSignal): Promise<ethers.Signature>;
    supersedeLedger(operations: readonly string[], options?: QueryOptions): Promise<void>;
    recordSignedAck(entry: StorageAckLedgerEntry, options?: QueryOptions): Promise<void>;
  };
}

type PreparedGraphCopy = {
  request: GraphScopedACKPersistenceRequest;
  normalized: Quad[];
  operationId: string;
  metaGraph: string;
  publicDigest: string;
  metadata: Quad[];
  operationSubject: string;
  incomingPrivateRoot?: string;
};

/** Owns the prepare, under-lock decision, copy commit, signature, and ledger phases. */
export class GraphScopedACKPersistence {
  constructor(private readonly dependencies: GraphScopedACKPersistenceDependencies) {}

  async execute(request: GraphScopedACKPersistenceRequest): Promise<GraphScopedACKPersistenceResult> {
    const copy = this.prepare(request);
    const locked = () => this.decideAndCommitUnderLock(copy);
    const locks = this.dependencies.config.workspaceWriteLocks;
    return locks
      ? withKeyedLocks(locks, [swmKaWriteLockKey(
        request.swmGraphId, request.graphPublish.subGraphName, request.graphPublish.scope.ual,
      )], locked)
      : locked();
  }

  private prepare(request: GraphScopedACKPersistenceRequest): PreparedGraphCopy {
    const { graphPublish, parsed, merkleRoot, swmGraphUri, swmGraphId, publisherPeerId } = request;
    const { graphManager, ports } = this.dependencies;
    ports.assertParsed(parsed);
    const normalized = parsed.map((quad) => ({ ...quad, graph: swmGraphUri }));
    const operationId = storageAckOperationId(
      graphPublish.scope.ual, graphPublish.scope.assertionVersion, merkleRoot,
    );
    const metaGraph = graphManager.sharedMemoryMetaUri(swmGraphId, graphPublish.subGraphName);
    const publicDigest = workspacePublicQuadsDigest(
      normalized.map((quad) => ({ ...quad, graph: '' })),
    );
    const metadata = generateKnowledgeAssetShareMetadata({
      shareOperationId: operationId,
      contextGraphId: swmGraphId,
      kaUal: graphPublish.scope.ual,
      assertionVersion: graphPublish.scope.assertionVersion,
      publicTripleCount: normalized.length,
      ...(graphPublish.privateMerkleRoot ? { privateMerkleRoot: graphPublish.privateMerkleRoot } : {}),
      privateTripleCount: graphPublish.privateTripleCount,
      publisherPeerId: publisherPeerId.trim() || 'unknown',
      ...(graphPublish.accessPolicy === undefined
        ? {}
        : { accessPolicy: graphPublish.accessPolicy, allowedPeers: graphPublish.allowedPeers }),
      agentAddress: graphPublish.scope.agentAddress,
      subGraphName: graphPublish.subGraphName,
      timestamp: new Date(),
    }, metaGraph);
    const operationSubject = metadata[0]?.subject;
    if (!operationSubject) throw new Error('StorageACK: graph-scoped workspace metadata is empty');
    metadata.push({
      subject: operationSubject,
      predicate: 'http://dkg.io/ontology/publicQuadsDigest',
      object: `"${publicDigest}"`,
      graph: metaGraph,
    });
    const incomingPrivateRoot = graphPublish.privateMerkleRoot
      ? ethers.hexlify(graphPublish.privateMerkleRoot).toLowerCase()
      : undefined;
    return {
      request, normalized, operationId, metaGraph, publicDigest, metadata,
      operationSubject, incomingPrivateRoot,
    };
  }

  private async decideAndCommitUnderLock(copy: PreparedGraphCopy): Promise<GraphScopedACKPersistenceResult> {
    const { request } = copy;
    const { ports } = this.dependencies;
    const commit = new ACKCommitSequence(request.signal);
    const persisted = await ports.runStoreOpOrDecline(request.cgId, async () => {
      const verdict = await ports.runWhileLive(() => ports.checkHead({
        cgId: request.cgId,
        swmGraphId: request.swmGraphId,
        scope: request.graphPublish.scope,
        subGraphName: request.graphPublish.subGraphName,
        publicDigest: copy.publicDigest,
        publicTripleCount: copy.normalized.length,
        privateTripleCount: request.graphPublish.privateTripleCount,
        privateMerkleRoot: copy.incomingPrivateRoot,
        publisherPeerId: request.publisherPeerId,
        context: request.context,
        signal: request.signal,
      }), request.signal);
      if (verdict.kind === 'decline') return verdict.decline;
      await this.commitCopy(copy, verdict, commit);
      return undefined;
    }, request.signal);
    if (!persisted.ok) return persisted;
    if (persisted.value !== undefined) return { ok: false, decline: persisted.value };

    // The copy and released old obligations may commit after the caller's
    // deadline. Only a live request can sign and create the incoming ledger row.
    const signature = await ports.signDigest(request.digest, request.signal);
    if (request.recordLedger) {
      const ledger = await this.recordLedger(copy, commit);
      if (!ledger.ok) return ledger;
    }
    return { ok: true, signature };
  }

  private async commitCopy(
    copy: PreparedGraphCopy,
    verdict: Exclude<AckCopyHeadVerdict, { kind: 'decline' }>,
    commit: ACKCommitSequence,
  ): Promise<void> {
    const { request, normalized, operationId, metaGraph, operationSubject, metadata } = copy;
    const { store, graphManager, config, ports } = this.dependencies;
    const { graphPublish, swmGraphId, swmGraphUri, replaceGraph } = request;
    const companion = graphPublish.subGraphName === undefined
      ? config.resolveDurableRootAtomicCompanion?.(Object.freeze({
          contextGraphId: swmGraphId,
          kaUal: graphPublish.scope.ual,
          assertionVersion: graphPublish.scope.assertionVersion,
          shareOperationId: operationId,
        }))
      : undefined;
    if (replaceGraph || companion !== undefined) {
      const replaced = await commit.write('storage-ack.persistGraphScoped.replaceGraph',
        (options) => tryReplaceGraphWithDurableRootCompanionAtomically(
          store, swmGraphUri, normalized, companion, options,
        ), (applied) => applied);
      if (!replaced) {
        throw Object.assign(
          new Error('Graph-scoped StorageACK requires atomic TripleStore.replaceGraph support'),
          { code: 'SWM_ATOMIC_REPLACE_UNSUPPORTED' },
        );
      }
      // REPLACE bypasses the catch-up lane's count gate.
      await commit.write('storage-ack.persistGraphScoped.witnessInvalidate',
        (options) => invalidateSwmMaterializationWitness(store, swmGraphUri, options)
          .catch(() => {}));
    }
    await commit.write('storage-ack.persistGraphScoped.deleteOperationMeta',
      (options) => deleteByPatternWithoutCount(store,
        { graph: metaGraph, subject: operationSubject }, options));
    await commit.write('storage-ack.persistGraphScoped.insertOperationMeta',
      (options) => store.insert(metadata, options));
    if (verdict.kind === 'replace-head') {
      await commit.write('storage-ack.persistGraphScoped.workspaceHead',
        (options) => storeKnowledgeAssetWorkspaceHead({
          store, graphManager, contextGraphId: swmGraphId,
          kaUal: graphPublish.scope.ual,
          assertionVersion: graphPublish.scope.assertionVersion,
          shareOperationId: operationId,
          subGraphName: graphPublish.subGraphName,
          queryOptions: options,
        }));
    }
    // Releasing obligations for overwritten data is part of the copy commit,
    // even when the request cannot sign after a deadline.
    await commit.write('storage-ack.ledger.supersede',
      (options) => ports.supersedeLedger(verdict.supersede, options));
    await commit.write('storage-ack.persistGraphScoped.flush',
      async (options) => { await store.flush?.(options); });
  }

  private async recordLedger(
    copy: PreparedGraphCopy,
    commit: ACKCommitSequence,
  ): Promise<{ ok: true } | { ok: false; decline: Uint8Array }> {
    const { request, operationSubject, metaGraph } = copy;
    const { store, ports } = this.dependencies;
    const entry: StorageAckLedgerEntry = {
      operationSubject,
      namespace: request.swmGraphId,
      metaGraph,
      contextGraphId: request.cgId,
      kaUal: request.graphPublish.scope.ual,
      assertionVersion: request.graphPublish.scope.assertionVersion,
      operation: BigInt(request.graphPublish.scope.assertionVersion) > 1n ? 'update' : 'publish',
      signedAt: new Date(),
      ...(request.graphPublish.subGraphName
        ? { subGraphName: request.graphPublish.subGraphName }
        : {}),
    };
    const ledger = await ports.runStoreOpOrDecline(request.cgId, async () => {
      await commit.write('storage-ack.ledger.record',
        (options) => ports.recordSignedAck(entry, options));
      await commit.write('storage-ack.ledger.flush',
        async (options) => { await store.flush?.(options); });
    }, request.signal);
    return ledger.ok ? { ok: true } : ledger;
  }
}
