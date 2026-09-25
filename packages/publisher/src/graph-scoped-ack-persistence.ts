import { createGraphKnowledgeAssetScope, assertSafeIri, assertSafeRdfTerm, contextGraphMetaUri, STORAGE_ACK_DECLINE_CODES, type GraphKnowledgeAssetAccessPolicy, type StorageACKDeclineCode } from '@origintrail-official/dkg-core';
import { type TripleStore, type GraphManager, type Quad, type QueryOptions, invalidateSwmMaterializationWitness, deleteByPatternWithoutCount } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { ACKCommitSequence } from './ack-commit-sequence.js';
import { tryReplaceGraphWithDurableRootCompanionAtomically, type DurableRootAtomicCompanionResolver } from './durable-root-atomic-companion.js';
import { swmKaWriteLockKey, withKeyedLocks } from './keyed-lock.js';
import { generateKnowledgeAssetShareMetadata } from './metadata.js';
import { storageAckOperationId, storageAckOwedCopiesByScopeQuery, STORAGE_ACK_LEDGER_PREDICATES, STORAGE_ACK_LEDGER_GRAPH, xsdDateTimeLiteral, storageAckLedgerRecordUpdate, storageAckLedgerEntryQuads, type StorageAckLedgerEntry } from './storage-ack-ledger.js';
import { planStorageAckHeadPersistence, type StorageAckRequestContext } from './storage-ack-head-policy.js';
import { workspacePublicQuadsDigest } from './workspace-snapshot-store.js';
import { storeKnowledgeAssetWorkspaceHead, tryResolveKnowledgeAssetWorkspaceHead, type KnowledgeAssetWorkspaceHead } from './workspace-resolution.js';

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

export const DEFAULT_PENDING_ACK_TX_WINDOW_MS = 5 * 60_000;

export interface StorageAckPriorVersionRequest {
  readonly contextGraphId: string;
  readonly swmGraphId: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
}

export interface GraphScopedACKPersistenceDependencies {
  store: TripleStore;
  graphManager: GraphManager;
  config: GraphScopedACKPersistenceConfig;
  ports: {
    encodeDecline(
      cgId: string, code: StorageACKDeclineCode, message: string,
      options?: { hookMessage?: string; labelCode?: StorageACKDeclineCode },
    ): Uint8Array;
    runWhileLive<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
    runStoreOpOrDecline<T>(cgId: string, work: () => Promise<T>, signal?: AbortSignal):
      Promise<{ ok: true; value: T } | { ok: false; decline: Uint8Array }>;
    isDeadlineAbort(error: unknown): boolean;
  };
}

/** Only the handler capabilities used by graph persistence. */
export interface GraphScopedACKPersistenceConfig {
  signerWallet: Pick<ethers.Wallet, 'signMessage'>;
  workspaceWriteLocks?: Map<string, Promise<void>>;
  resolveDurableRootAtomicCompanion?: DurableRootAtomicCompanionResolver;
  onPriorVersionAwaitingPromotion?: (request: StorageAckPriorVersionRequest) => void;
  readKnowledgeAssetRootCount?: (kaUal: string, signal?: AbortSignal) => Promise<bigint>;
  pendingAckTxWindowMs?: number;
}

function graphACKStoreOptions(source: string, signal?: AbortSignal): QueryOptions {
  return { priority: 'ack', source, ...(signal ? { signal } : {}) };
}

export function assertPersistQuadTermsSafe(quads: Quad[]): void {
  for (const q of quads) {
    assertSafeIri(q.subject);
    assertSafeIri(q.predicate);
    if (q.object.startsWith('"')) {
      assertSafeRdfTerm(q.object);
    } else {
      assertSafeIri(q.object);
    }
  }
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

  private get store(): TripleStore { return this.dependencies.store; }
  private get graphManager(): GraphManager { return this.dependencies.graphManager; }
  private get config(): GraphScopedACKPersistenceConfig { return this.dependencies.config; }

  private runWhileLive<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.dependencies.ports.runWhileLive(work, signal);
  }

  private encodeDecline(
    cgId: string, code: StorageACKDeclineCode, message: string,
    options?: { hookMessage?: string; labelCode?: StorageACKDeclineCode },
  ): Uint8Array {
    return this.dependencies.ports.encodeDecline(cgId, code, message, options);
  }

  private declineTemporarilyUnavailable(cgId: string, message: string, cause: unknown): Uint8Array {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return this.encodeDecline(cgId, STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
      message, { hookMessage: `${message}: ${detail}` });
  }

  private declineVmPromotionUnavailable(cgId: string, reason: string): Uint8Array {
    return this.encodeDecline(cgId, STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
      `VM promotion unavailable: ${reason}`, {
        labelCode: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
      });
  }

  private async signDigestWhileLive(digest: Uint8Array, signal?: AbortSignal): Promise<ethers.Signature> {
    const signed = await this.runWhileLive(() => this.config.signerWallet.signMessage(digest), signal);
    return ethers.Signature.from(signed);
  }

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
    const { graphManager } = this.dependencies;
    assertPersistQuadTermsSafe(parsed);
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
      const verdict = await ports.runWhileLive(() => this.checkAckCopyAgainstHead({
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
    const signature = await this.signDigestWhileLive(request.digest, request.signal);
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
    const { store, graphManager, config } = this.dependencies;
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
      (options) => this.supersedeLedgerOperations(verdict.supersede, options));
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
        (options) => this.recordSignedAck(entry, options));
      await commit.write('storage-ack.ledger.flush',
        async (options) => { await store.flush?.(options); });
    }, request.signal);
    return ledger.ok ? { ok: true } : ledger;
  }
  private notifyPriorVersionAwaitingPromotion(request: StorageAckPriorVersionRequest): void {
    const hook = this.config.onPriorVersionAwaitingPromotion;
    if (!hook) return;
    try {
      hook(request);
    } catch {
      // A promotion nudge must never change the ACK decision.
    }
  }

  /**
   * Signed copies this core still owes for the head's workspace scope. The
   * local self-ACK may preserve a different queued operation as the head, so
   * head aliases alone cannot identify every outstanding signed copy.
   */
  private async owedHeadOperations(
    swmGraphId: string,
    head: KnowledgeAssetWorkspaceHead,
    subGraphName?: string,
    signal?: AbortSignal,
  ): Promise<Array<{ op: string; signedAtMs: number; absentSeen: boolean }>> {
    const result = await this.store.query(
      storageAckOwedCopiesByScopeQuery({
        namespace: swmGraphId,
        metaGraph: this.graphManager.sharedMemoryMetaUri(swmGraphId, subGraphName),
        kaUal: head.kaUal,
        assertionVersion: head.assertionVersion,
      }),
      graphACKStoreOptions('storage-ack.persistGraphScoped.owedHead', signal),
    );
    if (result.type !== 'bindings') return [];
    const owed = new Map<string, { op: string; signedAtMs: number; absentSeen: boolean }>();
    for (const row of result.bindings) {
      const op = row['op'];
      if (typeof op !== 'string' || op.length === 0) continue;
      const literal = row['signedAt'] ?? '';
      const lexical = literal.startsWith('"') ? literal.slice(1, literal.indexOf('"', 1)) : literal;
      const parsed = Date.parse(lexical);
      const previous = owed.get(op);
      owed.set(op, {
        op,
        // An unreadable timestamp counts as recent: never release on a guess.
        signedAtMs: Math.max(Number.isFinite(parsed) ? parsed : Date.now(), previous?.signedAtMs ?? -Infinity),
        absentSeen: (previous?.absentSeen ?? false) || row['absentSeen'] !== undefined,
      });
    }
    return [...owed.values()];
  }

  private declineStaleLocalHead(cgId: string): AckCopyHeadVerdict {
    return {
      kind: 'decline',
      decline: this.encodeDecline(
        cgId,
        STORAGE_ACK_DECLINE_CODES.CONFLICTING_KA_ASSERTION,
        'Local publisher workspace head changed after the publish intent was queued',
      ),
    };
  }

  /**
   * The asset's on-chain Merkle-root count (its latest landed version), or
   * `count: undefined` when no chain view is wired. A failed read is a
   * transient decline: the ACK must not be decided on a guess.
   */
  private async readRootCountOrDecline(
    cgId: string,
    kaUal: string,
    signal?: AbortSignal,
  ): Promise<{ count: bigint | undefined } | { decline: Uint8Array }> {
    const read = this.config.readKnowledgeAssetRootCount;
    if (!read) return { count: undefined };
    try {
      const count = await this.runWhileLive(() => read(kaUal, signal), signal);
      return { count };
    } catch (err) {
      if (this.dependencies.ports.isDeadlineAbort(err)) throw err;
      signal?.throwIfAborted();
      return {
        decline: this.declineTemporarilyUnavailable(cgId, 'chain version lookup unavailable', err),
      };
    }
  }

  /**
   * The ACK-copy counterpart of the SWM gossip monotonicity gate, run under
   * the per-KA write lock before the copy is written. Returns a decline when
   * the copy must not replace the current head, and otherwise the owed ledger
   * rows the replacement supersedes. A head that already records exactly this
   * content is preserved only for an exact local queued operation.
   *
   * Only a copy this core signed and still owes can hold the head: any other
   * head (a gossip draft, a synced copy, a copy already released) is replaced.
   * Against an owed copy:
   *   - an older version is refused (CONFLICTING_KA_ASSERTION, as gossip does);
   *   - the same version with different content is refused only once that
   *     version has landed on chain, when the request cannot land either.
   *     Before that the held copy is replaced: a retry after a failed round
   *     reuses the version, and holding it would lock the asset for a TTL;
   *   - a newer version replaces it once the held version is in this
   *     namespace's VM, or at once when the chain has already moved past the
   *     held version (it can no longer be promoted as-is). Otherwise the core
   *     declines transiently and asks for the held version to be promoted.
   */
  private async checkAckCopyAgainstHead(input: {
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
  }): Promise<AckCopyHeadVerdict> {
    const replace = { kind: 'replace-head' as const, supersede: [] as readonly string[] };
    const resolution = await tryResolveKnowledgeAssetWorkspaceHead({
      store: this.store,
      graphManager: this.graphManager,
      contextGraphId: input.swmGraphId,
      kaUal: input.scope.ual,
      subGraphName: input.subGraphName,
      queryOptions: graphACKStoreOptions('storage-ack.persistGraphScoped.headCheck', input.signal),
    });
    if (resolution.status === 'corrupt') {
      // The gossip path defers the same way: the sync lane repairs the head.
      return {
        kind: 'decline',
        decline: this.encodeDecline(
          input.cgId,
          STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
          'SWM head for this Knowledge Asset is being repaired',
          { hookMessage: `corrupt SWM head for ${input.scope.ual}: ${resolution.error.message}` },
        ),
      };
    }
    const head = resolution.status === 'resolved' ? resolution.head : undefined;
    const policy = planStorageAckHeadPersistence({
      context: input.context,
      head,
      kaUal: input.scope.ual,
      assertionVersion: input.scope.assertionVersion,
      publisherPeerId: input.publisherPeerId,
      publicDigest: input.publicDigest,
      publicTripleCount: input.publicTripleCount,
      privateTripleCount: input.privateTripleCount,
      privateMerkleRoot: input.privateMerkleRoot,
    });
    if (policy.kind === 'decline-stale-local-head') return this.declineStaleLocalHead(input.cgId);
    if (policy.kind === 'preserve-head' || policy.kind === 'replace-head') {
      return { kind: policy.kind, supersede: [] };
    }
    if (!head) throw new Error('StorageACK head policy requested conflict check without a head');
    const incomingVersion = BigInt(input.scope.assertionVersion);
    const currentVersion = BigInt(head.assertionVersion);
    const owedRows = await this.owedHeadOperations(input.swmGraphId, head, input.subGraphName, input.signal);
    if (owedRows.length === 0) return replace;
    const owed = owedRows.map((row) => row.op);
    if (incomingVersion < currentVersion) {
      return {
        kind: 'decline',
        decline: this.encodeDecline(
          input.cgId,
          STORAGE_ACK_DECLINE_CODES.CONFLICTING_KA_ASSERTION,
          `stale assertion version ${incomingVersion}: this core holds version ${currentVersion}`,
        ),
      };
    }
    if (incomingVersion === currentVersion) {
      const landed = await this.readRootCountOrDecline(input.cgId, input.scope.ual, input.signal);
      if ('decline' in landed) return { kind: 'decline', decline: landed.decline };
      if (landed.count === undefined || landed.count >= currentVersion) {
        return {
          kind: 'decline',
          decline: this.encodeDecline(
            input.cgId,
            STORAGE_ACK_DECLINE_CODES.CONFLICTING_KA_ASSERTION,
            `assertion version ${incomingVersion} is already bound to different content on this core`,
          ),
        };
      }
      // Not on chain yet is not proof it never will be: the held copy's
      // transaction may still be pending. Release it only once the audit saw
      // it absent, or once it is older than any quorum round plus inclusion.
      const pendingWindowMs = this.config.pendingAckTxWindowMs ?? DEFAULT_PENDING_ACK_TX_WINDOW_MS;
      const now = Date.now();
      const dead = owedRows.every((row) => row.absentSeen || now - row.signedAtMs > pendingWindowMs);
      if (!dead) {
        return {
          kind: 'decline',
          decline: this.declineVmPromotionUnavailable(
            input.cgId,
            `a copy of version ${currentVersion} this core signed may still land on chain; retry later`,
          ),
        };
      }
      return { kind: 'replace-head', supersede: owed };
    }
    // An update replaces the per-KA SWM graph, which is not versioned. Only do
    // that once the older version is in this namespace's VM, so an update
    // that never lands cannot destroy the copy an earlier ACK still owes.
    const promoted = await this.store.query(
      `ASK { GRAPH <${contextGraphMetaUri(input.swmGraphId)}> {
        <${input.scope.ual}> <http://dkg.io/ontology/status> "confirmed" ;
          <http://dkg.io/ontology/assertionVersion> ?version .
        FILTER(?version >= ${currentVersion})
      } }`,
      graphACKStoreOptions('storage-ack.persistGraphScoped.priorVersionPromoted', input.signal),
    );
    if (promoted.type === 'boolean' && promoted.value) return replace;
    // A later version may have landed without this core. Its held copy can
    // then never be promoted as-is (promotion follows the chain's latest
    // root), so release it instead of waiting on a promotion that fails.
    const chain = await this.readRootCountOrDecline(input.cgId, input.scope.ual, input.signal);
    if ('decline' in chain) return { kind: 'decline', decline: chain.decline };
    if (chain.count !== undefined && chain.count > currentVersion) return { kind: 'replace-head', supersede: owed };
    this.notifyPriorVersionAwaitingPromotion({
      contextGraphId: input.cgId,
      swmGraphId: input.swmGraphId,
      kaUal: input.scope.ual,
      assertionVersion: currentVersion.toString(),
      ...(input.subGraphName ? { subGraphName: input.subGraphName } : {}),
    });
    return {
      kind: 'decline',
      decline: this.declineVmPromotionUnavailable(
        input.cgId,
        `version ${currentVersion} of this Knowledge Asset is still awaiting promotion on this core`,
      ),
    };
  }

  /** Release ledger rows whose copy a newer write replaced (see {@link checkAckCopyAgainstHead}). */
  private async supersedeLedgerOperations(operations: readonly string[], options?: QueryOptions): Promise<void> {
    if (operations.length === 0) return;
    const at = xsdDateTimeLiteral(new Date());
    await this.store.insert(
      operations.map((operation) => ({
        subject: operation,
        predicate: STORAGE_ACK_LEDGER_PREDICATES.supersededAt,
        object: at,
        graph: STORAGE_ACK_LEDGER_GRAPH,
      })),
      options ?? graphACKStoreOptions('storage-ack.ledger.supersede'),
    );
  }

  /**
   * Record an ACK this core has signed: one atomic update that keeps the
   * row's `registeredAt` and leaves no window without a row. Called under
   * the per-KA write lock after signing succeeds.
   */
  private async recordSignedAck(entry: StorageAckLedgerEntry, options?: QueryOptions): Promise<void> {
    const signed = { ...entry, signedAt: new Date() };
    if (typeof this.store.update === 'function') {
      await this.store.update(
        storageAckLedgerRecordUpdate(signed),
        {
          ...(options ?? graphACKStoreOptions('storage-ack.ledger.record')),
          // The update writes only the ledger graph. Naming it keeps a
          // graph-set index current with one bounded probe; an undeclared
          // update makes the next graph listing rescan the whole store.
          touchedGraphs: [STORAGE_ACK_LEDGER_GRAPH],
        },
      );
      return;
    }
    await this.store.insert(
      storageAckLedgerEntryQuads(signed),
      options ?? graphACKStoreOptions('storage-ack.ledger.insert'),
    );
  }

}
