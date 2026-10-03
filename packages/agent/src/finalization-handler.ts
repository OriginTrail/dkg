import {
  decodeFinalizationMessage,
  contextGraphMetaUri,
  validateSubGraphName, validateContextGraphId,
  DKGEvent, Logger, createOperationContext,
  assertSafeIri,
  type EventBus,
  type FinalizationMessageMsg,
  type OperationContext,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  resolveGraphScopedOrLegacyMetadata,
  resolveSharedMemoryScopeGraphs,
  tryReplaceGraphAtomically,
  tryReplaceGraphAndSubjectAtomically,
  StoreSchedulerBusyError,
  type TripleStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  resolvePublicFinalizedMaterializationAuthority,
  type ChainAdapter,
  type PublicFinalizedMaterializationVersionSnapshot,
} from '@origintrail-official/dkg-chain';
import {
  generateGraphKnowledgeAssetMetadata,
  compareMaterializedVersion, readMaterializedVersion,
  writeMaterializedVersion, materializedVersionQuad,
  withMaterializationLock,
  workspacePublicQuadsDigest,
  KnowledgeAssetWorkspaceHeadCorruptError,
  isKnowledgeAssetWorkspaceHeadCorruptError,
  resolveKnowledgeAssetWorkspaceHead,
  type MaterializedVersion,
  type KnowledgeAssetWorkspaceHead,
  type WorkspaceOperationAccessEnvelope,
  type OnChainProvenance,
} from '@origintrail-official/dkg-publisher';
const DKG_NS = 'http://dkg.io/ontology/';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const CHAIN_FINALIZED_RECONCILE_PEER_ID = 'chain-finalized-reconcile-v1';
import { ethers } from 'ethers';
import {
  FinalizationLifecycleLogger,
  finalizationLifecycleDecision,
  type FinalizationLifecycleLogOptions,
} from './finalization-lifecycle-logger.js';
import type { FinalizationRuntime } from './finalization-runtime.js';
import {
  FinalizationRecoveryCapacityError,
  FinalizationRecovery,
  type FinalizationRecoveryApplyOutcome,
  type FinalizationRecoveryInvalidationOutcome,
  type FinalizationRecoveryLiveInput,
  type FinalizationRecoveryLiveProcessResult,
  type FinalizationRecoveryMaterializer,
  type FinalizationRecoveryPreparedMaterialization,
  type FinalizationRecoveryReplayOutcome,
} from './finalization-recovery.js';
import {
  FinalizationRecoveryWorker,
} from './finalization-recovery-worker.js';
import type {
  FinalizationRecoveryEntry,
  FinalizationRecoveryStore,
} from './finalization-recovery-store.js';
import {
  type GraphScopedAccessEnvelope,
  type ParsedGraphScopedFinalization,
  type VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';
import { recoverReceiptBackedGraphScopedEvidence } from './receipt-backed-graph-scoped-evidence.js';
import {
  resolveConfirmedGraphScopedVm,
  resolveLocallyConfirmedGraphScopedVm,
} from './confirmed-graph-scoped-vm-resolver.js';
import {
  verifyExactGraphContent,
  type ExactGraphContentVerification,
  type VerifiedExactGraphContent,
} from './exact-graph-content-verifier.js';
import type {
  FinalizedSwmTwinCatalogProjectionEvidence,
  RetireConfirmedGraphScopedSwmTwinIfOrphaned,
} from
  './sync/requester/finalized-swm-twin-reconciliation.js';
import {
  createDurableFinalizationRecoveryEligibility,
  type FinalizationRecoveryEligibility,
} from './finalization-recovery-eligibility.js';

/**
 * Predicate for the durable per-root keep-root-copy signal the publisher
 * persists into SWM workspace meta at publish time. Nothing in this release
 * reads it: the gossip envelope carries the same decision as
 * `keepRootCopyOnLabel`. It is still written for peers on releases whose
 * chain reconcile promotes from workspace operations.
 */
export const KEEP_ROOT_COPY_PREDICATE = `${DKG_NS}keepRootCopyOnLabel`;

/**
 * Resolves a local context-graph id (the topic/CG name used in gossip) to
 * its on-chain numeric id. Returns `null`/`undefined` for CGs that aren't
 * registered on-chain. Used as a fallback when a peer-finalization gossip
 * envelope omits `targetContextGraphId` (e.g. a pre-cd68fa689 publisher
 * still in the mesh).
 */
export type ResolveContextGraphOnChainId = (
  contextGraphId: string,
) => Promise<string | null | undefined>;

export type MarkContextGraphMetaDirtyFromQuads = (quads: readonly Quad[]) => void;

function stripOptionalLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      const lastQuote = value.lastIndexOf('"');
      return value.slice(1, lastQuote > 0 ? lastQuote : undefined);
    }
  }
  return value;
}

function sameBigIntLiteral(left: string | bigint | null | undefined, right: string | bigint | null | undefined): boolean {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

type ExactGraphScopedLayerVerification = ExactGraphContentVerification;
type VerifiedGraphScopedLayer = VerifiedExactGraphContent;

/**
 * Exact local content accepted by the receiptless public-finalization policy.
 * The layer is the only semantic difference between metadata-only VM repair
 * and SWM-to-VM promotion; callers cannot independently choose the associated
 * `contentAlreadyMaterialized` behavior.
 */
type VerifiedPublicFinalizedLayer =
  | {
      layer: MemoryLayer.VerifiableMemory;
      verification: VerifiedGraphScopedLayer;
    }
  | {
      layer: MemoryLayer.SharedWorkingMemory;
      verification: VerifiedGraphScopedLayer;
    };

type PublicFinalizedMaterializationOutcome =
  | 'promoted'
  | 'already-confirmed'
  | 'stale-target'
  | 'verified-vm-metadata-pending';

type GraphScopedMaterializationEnvelope = Pick<
  KnowledgeAssetWorkspaceHead,
  | 'publicTripleCount'
  | 'privateMerkleRoot'
  | 'privateTripleCount'
  | 'publisherPeerId'
> & Readonly<{
  access: WorkspaceOperationAccessEnvelope;
}>;

/** Immutable queued assertion envelope supplied only after receipt/seal validation. */
type TrustedGraphScopedAssertionEvidence = VerifiedGraphScopedFinalizationEvidence;

function resolveGraphScopedAccessEnvelope(
  head: GraphScopedMaterializationEnvelope,
  requestedAccess?: GraphScopedAccessEnvelope,
): GraphScopedAccessEnvelope {
  const selected = requestedAccess ?? head.access;
  const accessPolicy = selected.accessPolicy;
  const allowedPeers = accessPolicy === 'allowList'
    ? selected.allowedPeers
    : [];
  if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
    return { accessPolicy: 'ownerOnly', allowedPeers: [] };
  }
  return { accessPolicy, allowedPeers: [...allowedPeers] };
}

function normalizedHex(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}

export interface FinalizationHandlerOptions {
  eventBus?: EventBus;
  resolveContextGraphOnChainId?: ResolveContextGraphOnChainId;
  markContextGraphMetaDirtyFromQuads?: MarkContextGraphMetaDirtyFromQuads;
  retireConfirmedGraphScopedSwmTwinIfOrphaned?:
    RetireConfirmedGraphScopedSwmTwinIfOrphaned;
  reconcileConfirmedGraphScopedSwmTwin?: (
    evidence: Readonly<FinalizedSwmTwinCatalogProjectionEvidence>,
    ctx: OperationContext,
  ) => Promise<void>;
  lifecycleLogOptions?: FinalizationLifecycleLogOptions;
  recoveryStore?: FinalizationRecoveryStore;
  runtime?: FinalizationRuntime;
  workspaceWriteLocks?: Map<string, Promise<void>>;
  finalizationRecoveryEligibility?: FinalizationRecoveryEligibility;
}

function isLegacyFinalizationEventBus(
  value: FinalizationHandlerOptions | EventBus | undefined,
): value is EventBus {
  return value !== undefined
    && typeof (value as EventBus).emit === 'function';
}

function normalizeFinalizationHandlerOptions(
  optionsOrEventBus: FinalizationHandlerOptions | EventBus | undefined,
  resolveContextGraphOnChainId: ResolveContextGraphOnChainId | undefined,
  markContextGraphMetaDirtyFromQuads: MarkContextGraphMetaDirtyFromQuads | undefined,
  lifecycleLogOptions: FinalizationLifecycleLogOptions | undefined,
): FinalizationHandlerOptions {
  const hasLegacyTail = resolveContextGraphOnChainId !== undefined
    || markContextGraphMetaDirtyFromQuads !== undefined
    || lifecycleLogOptions !== undefined;
  if (!hasLegacyTail && !isLegacyFinalizationEventBus(optionsOrEventBus)) {
    return (optionsOrEventBus as FinalizationHandlerOptions | undefined) ?? {};
  }
  return {
    ...(optionsOrEventBus ? { eventBus: optionsOrEventBus as EventBus } : {}),
    ...(resolveContextGraphOnChainId ? { resolveContextGraphOnChainId } : {}),
    ...(markContextGraphMetaDirtyFromQuads ? { markContextGraphMetaDirtyFromQuads } : {}),
    ...(lifecycleLogOptions ? { lifecycleLogOptions } : {}),
  };
}

export interface ChainReconciledKCInput {
  contextGraphId: string;
  onChainCgId: string;
  ual: string;
  /** Exact current chain rootCount when the caller has one coherent snapshot. */
  assertionVersion?: bigint;
  merkleRoot: Uint8Array;
  publisherAddress: string;
  kaId: bigint;
  batchId: bigint;
  versionBlock: number;
  authorAddress?: string;
  /** Operation-scoped coherent snapshot; never retained across exact fetches. */
  versionSnapshot?: PublicFinalizedMaterializationVersionSnapshot;
  /** Exact-fetch lifecycle fence; abort must never degrade to a live fallback. */
  signal?: AbortSignal;
  subGraphName?: string;
  trustedAssertionEvidence?: TrustedGraphScopedAssertionEvidence;
}

export type ChainReconciledKCOutcome =
  | 'promoted'
  | 'already-confirmed'
  | 'no-swm'
  | 'unverified'
  | 'receipt-revalidation-pending'
  | 'stale-target'
  | 'verified-vm-metadata-pending';

/** The part of an ordinary chain reconcile input that is known before any chain root read. */
export type ChainReconcileLocalCandidateInput = Pick<
  ChainReconciledKCInput,
  'contextGraphId' | 'onChainCgId' | 'ual' | 'kaId' | 'batchId' | 'subGraphName'
>;

/**
 * What an ordinary chain reconcile could find locally for one KA, decided
 * without a chain read (see `classifyChainReconcileLocalCandidate`).
 *  - `none`: the store holds nothing for this KA, so `handleChainReconciledKC`
 *    answers `no-swm` whatever the chain root is.
 *  - `confirmed-vm`: a confirmed VM copy and nothing else that could promote.
 *  - `present`: anything else; the outcome depends on the chain root.
 */
export type ChainReconcileLocalCandidate =
  | { readonly kind: 'none' }
  | { readonly kind: 'confirmed-vm'; readonly layout: 'graph-scoped' | 'legacy' }
  | { readonly kind: 'present' };

const LOCAL_CANDIDATE_PRESENT: ChainReconcileLocalCandidate = Object.freeze({ kind: 'present' });

interface ExactChainReconcileDecision {
  outcome: ChainReconciledKCOutcome;
  legacyMarkerEligible: boolean;
  input: ChainReconciledKCInput;
}

type VerifiedGraphScopedConfirmation =
  | {
      kind: 'transaction';
      txHash: string;
      publisherAddress: string;
      blockNumber: number;
      materializedVersion: MaterializedVersion;
    }
  | {
      kind: 'finalized-materialization';
      materializedVersion: MaterializedVersion;
    };

interface PreparedGraphScopedMaterialization
  extends FinalizationRecoveryPreparedMaterialization {
  candidate: ParsedGraphScopedFinalization;
  contextGraphId: string;
  ctxGraphId?: string;
  subGraphName?: string;
  ctx: OperationContext;
  head: GraphScopedMaterializationEnvelope;
  vmVerification: ExactGraphScopedLayerVerification;
  layerVerification: Extract<ExactGraphScopedLayerVerification, { status: 'verified' }>;
}

export class FinalizationHandler {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly resolveContextGraphOnChainId: ResolveContextGraphOnChainId | undefined;
  private readonly markContextGraphMetaDirtyFromQuads: MarkContextGraphMetaDirtyFromQuads | undefined;
  private readonly retireConfirmedGraphScopedSwmTwinIfOrphaned:
    RetireConfirmedGraphScopedSwmTwinIfOrphaned | undefined;
  private readonly reconcileConfirmedGraphScopedSwmTwin:
    FinalizationHandlerOptions['reconcileConfirmedGraphScopedSwmTwin'];
  private readonly recovery: FinalizationRecovery<PreparedGraphScopedMaterialization>;
  private readonly log = new Logger('FinalizationHandler');
  private readonly lifecycle: FinalizationLifecycleLogger;
  private readonly processedUals = new Set<string>();
  // Forward-prevention for the cgId-resolution race (RS heal): chain-authoritative
  // KA-id -> cgId bindings, cached POSITIVE-ONLY. A 0/miss is NEVER cached:
  // caching a miss before the on-chain KA->CG binding lands would pin
  // finalization to the local fallback forever.
  private readonly chainCgIdByLookupId = new Map<string, string>();
  private readonly recoveryWorker: FinalizationRecoveryWorker;
  private readonly finalizationRecoveryEligibility: FinalizationRecoveryEligibility;

  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    options?: FinalizationHandlerOptions,
  );
  /** @deprecated Use the explicit `FinalizationHandlerOptions` constructor. */
  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    eventBus?: EventBus,
    resolveContextGraphOnChainId?: ResolveContextGraphOnChainId,
    markContextGraphMetaDirtyFromQuads?: MarkContextGraphMetaDirtyFromQuads,
    lifecycleLogOptions?: FinalizationLifecycleLogOptions,
  );
  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    optionsOrEventBus?: FinalizationHandlerOptions | EventBus,
    legacyResolveContextGraphOnChainId?: ResolveContextGraphOnChainId,
    legacyMarkContextGraphMetaDirtyFromQuads?: MarkContextGraphMetaDirtyFromQuads,
    legacyLifecycleLogOptions?: FinalizationLifecycleLogOptions,
  ) {
    const options = normalizeFinalizationHandlerOptions(
      optionsOrEventBus,
      legacyResolveContextGraphOnChainId,
      legacyMarkContextGraphMetaDirtyFromQuads,
      legacyLifecycleLogOptions,
    );
    this.store = store;
    this.chain = chain;
    this.eventBus = options.eventBus;
    this.resolveContextGraphOnChainId = options.resolveContextGraphOnChainId;
    this.markContextGraphMetaDirtyFromQuads = options.markContextGraphMetaDirtyFromQuads;
    this.retireConfirmedGraphScopedSwmTwinIfOrphaned =
      options.retireConfirmedGraphScopedSwmTwinIfOrphaned;
    this.reconcileConfirmedGraphScopedSwmTwin =
      options.reconcileConfirmedGraphScopedSwmTwin;
    this.finalizationRecoveryEligibility = options.finalizationRecoveryEligibility
      ?? createDurableFinalizationRecoveryEligibility({
        store,
        writeLocks: options.workspaceWriteLocks,
      });
    this.lifecycle = new FinalizationLifecycleLogger(
      this.log,
      options.runtime ?? options.lifecycleLogOptions,
    );
    const materializer: FinalizationRecoveryMaterializer<PreparedGraphScopedMaterialization> = {
      prepare: (input) => this.prepareGraphScopedMaterialization(input),
      apply: (input) => this.applyPreparedGraphScopedMaterialization(input),
      recoverVerifiedEvidence: (input) => (
        this.recoverVerifiedGraphScopedEvidenceFromConfirmedVm(input)
      ),
      replayVerified: ({ replay, candidate, evidence }) => this.reconcileGraphScopedKC({
        contextGraphId: replay.contextGraphId,
        ual: replay.ual,
        merkleRoot: ethers.getBytes(replay.merkleRoot),
        publisherAddress: evidence.publisherAddress,
        kaId: BigInt(replay.kaId),
        batchId: candidate.batchId,
        versionBlock: evidence.blockNumber,
        ...(evidence.authorAddress ? { authorAddress: evidence.authorAddress } : {}),
        ...(evidence.subGraphName ? { subGraphName: evidence.subGraphName } : {}),
        trustedAssertionEvidence: evidence,
      }, candidate.msg.operationId
        ? createOperationContext('sync', candidate.msg.operationId)
        : createOperationContext('sync')),
      invalidateVerified: (input) => this.invalidateVerifiedGraphScopedFinalization(input),
      isRetryableError: (error) => error instanceof StoreSchedulerBusyError,
    };
    this.recovery = new FinalizationRecovery(
      options.runtime ?? options.recoveryStore,
      chain,
      {
        info: (message) => this.log.info(createOperationContext('system'), message),
        warn: (message) => this.log.warn(createOperationContext('system'), message),
      },
      materializer,
    );
    this.recoveryWorker = new FinalizationRecoveryWorker(
      (limit) => this.recovery.processDueBatch(limit),
      {
        info: (message) => this.log.info(createOperationContext('system'), message),
        warn: (message) => this.log.warn(createOperationContext('system'), message),
      },
    );
  }

  startRecoveryWorker(): void {
    this.recoveryWorker.start();
  }

  stopRecoveryWorker(): Promise<void> {
    return this.recoveryWorker.stop();
  }

  async handleFinalizationMessage(
    data: Uint8Array,
    contextGraphId: string,
    sourcePeerId?: string,
  ): Promise<void> {
    const liveAdmission = this.recovery.admitLive({
      rawMessage: data,
      contextGraphId,
      ...(sourcePeerId ? { sourcePeerId } : {}),
    });
    if (liveAdmission.status === 'invalid') return;

    let candidate: ParsedGraphScopedFinalization | undefined;
    if (liveAdmission.status === 'admitted') {
      const liveCandidate = liveAdmission.input.candidate;
      candidate = liveCandidate;
      const recoveryEligible = await this.finalizationRecoveryEligibility({
        contextGraphId,
        ual: liveCandidate.scope.ual,
        subGraphName: liveCandidate.msg.subGraphName || undefined,
        targetContextGraphId: liveCandidate.msg.targetContextGraphId || undefined,
        onProbeError: (error) => {
          const ctx = liveCandidate.msg.operationId
            ? createOperationContext('gossip', liveCandidate.msg.operationId)
            : createOperationContext('gossip');
          this.log.warn(
            ctx,
            `Finalization: local workspace ownership probe failed for `
              + `${liveCandidate.scope.ual}; retaining recovery eligibility: `
              + `${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
      if (!recoveryEligible) {
        const ctx = liveCandidate.msg.operationId
          ? createOperationContext('gossip', liveCandidate.msg.operationId)
          : createOperationContext('gossip');
        this.log.info(
          ctx,
          `Finalization: ignoring ${liveCandidate.scope.ual}; this node has no local workspace record`,
        );
        return;
      }
      let recoveryResult: FinalizationRecoveryLiveProcessResult;
      try {
        recoveryResult = await this.recovery.processLiveOutcome(liveAdmission.input);
      } catch (error) {
        if (
          error instanceof StoreSchedulerBusyError
        ) throw error;
        const ctx = candidate.msg.operationId
          ? createOperationContext('gossip', candidate.msg.operationId)
          : createOperationContext('gossip');
        const reason = error instanceof Error ? error.message : String(error);
        this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_failed', {
          ...candidate.msg,
          contextGraphId,
          rootEntityCount: candidate.msg.rootEntities.length,
          outcome: 'failed',
          retryable: true,
          reason,
          level: 'warn',
        }));
        this.log.warn(ctx, `Finalization: failed to process graph-scoped message: ${reason}`);
        return;
      }
      switch (recoveryResult.status) {
        case 'handled':
          return;
        case 'retryable-capacity':
          throw new FinalizationRecoveryCapacityError(recoveryResult.ual);
        case 'fallback':
          break;
        default: {
          const exhaustive: never = recoveryResult;
          throw new Error(`Unhandled finalization recovery result: ${JSON.stringify(exhaustive)}`);
        }
      }
    } else {
      this.ignoreUnscopedFinalization(data, contextGraphId);
      return;
    }

    // A deployment without the durable recovery inbox applies the envelope
    // unjournaled.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.processUnjournaledFinalization(liveAdmission.input);
        return;
      } catch (error) {
        if (!(error instanceof StoreSchedulerBusyError)) throw error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        this.log.warn(
          candidate?.msg.operationId
            ? createOperationContext('gossip', candidate.msg.operationId)
            : createOperationContext('gossip'),
          `Finalization: store remained busy after retry; `
            + 'no durable recovery envelope is configured',
        );
        throw error;
      }
    }
  }

  private decodeFinalizationMessageOrWarn(rawMessage: Uint8Array): FinalizationMessageMsg | undefined {
    try {
      return decodeFinalizationMessage(rawMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/wire type|index out of range|offset|unexpected tag/i.test(message)) {
        this.log.warn(
          createOperationContext('gossip'),
          `Finalization: failed to decode message: ${message}`,
        );
      }
      return undefined;
    }
  }

  private async replayMatchingRecoveryEntries(
    input: ChainReconciledKCInput,
    _ctx: OperationContext,
  ): Promise<FinalizationRecoveryReplayOutcome> {
    return this.recovery.replayMatching({
      chainId: this.chain?.chainId ?? 'none',
      contextGraphId: input.contextGraphId,
      onChainCgId: input.onChainCgId,
      ual: input.ual,
      merkleRoot: ethers.hexlify(input.merkleRoot),
      kaId: input.kaId.toString(),
      // Recovery replay keeps its established live root/count reads. Its store
      // awaits are independent of the later public-authority snapshot fence.
    });
  }

  private async resolveFinalizationContextGraphId(
    contextGraphId: string,
    targetContextGraphId: string | undefined,
    chainLookupId: bigint,
    ctx: OperationContext,
    localTopicOnChainContextGraphId?: string,
  ): Promise<string | undefined> {
    let ctxGraphId = targetContextGraphId;
    if (ctxGraphId) return ctxGraphId;

    const cacheKey = chainLookupId > 0n ? chainLookupId.toString() : '';
    if (cacheKey && this.chainCgIdByLookupId.has(cacheKey)) {
      return this.chainCgIdByLookupId.get(cacheKey);
    }
    if (
      cacheKey
      && this.chain
      && this.chain.chainId !== 'none'
      && typeof this.chain.getKAContextGraphId === 'function'
    ) {
      try {
        const boundCg = await this.chain.getKAContextGraphId(chainLookupId);
        if (boundCg !== null && boundCg !== undefined && BigInt(boundCg) > 0n) {
          ctxGraphId = boundCg.toString();
          this.chainCgIdByLookupId.set(cacheKey, ctxGraphId);
          this.log.info(
            ctx,
            `Finalization: resolved cgId from chain truth `
              + `getKAContextGraphId(${chainLookupId})=${ctxGraphId}`,
          );
        }
      } catch (error) {
        this.log.info(
          ctx,
          `Finalization: chain getKAContextGraphId(${chainLookupId}) failed (RPC lag?), `
            + `falling back to local resolve: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!ctxGraphId && localTopicOnChainContextGraphId) {
      ctxGraphId = localTopicOnChainContextGraphId;
      this.log.info(
        ctx,
        `Finalization: gossip omitted targetContextGraphId; `
          + `resolved local topic to ${ctxGraphId}`,
      );
    }
    if (!ctxGraphId && this.resolveContextGraphOnChainId) {
      try {
        const resolved = await this.resolveContextGraphOnChainId(contextGraphId);
        if (resolved !== null && resolved !== undefined && String(resolved).length > 0) {
          ctxGraphId = String(resolved);
          this.log.info(
            ctx,
            `Finalization: gossip omitted targetContextGraphId; `
              + `resolved locally to ${ctxGraphId} (defensive lookup)`,
          );
        }
      } catch (error) {
        this.log.warn(
          ctx,
          `Finalization: defensive on-chain CG id lookup failed for ${contextGraphId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return ctxGraphId;
  }

  /** Resolve the local gossip topic independently from wire and KA identities. */
  private async resolveLocalTopicOnChainContextGraphId(
    contextGraphId: string,
    ctx: OperationContext,
  ): Promise<string | undefined> {
    if (!this.resolveContextGraphOnChainId) return undefined;
    try {
      const resolved = await this.resolveContextGraphOnChainId(contextGraphId);
      if (resolved === null || resolved === undefined || String(resolved).length === 0) {
        return undefined;
      }
      const normalized = BigInt(resolved).toString();
      return BigInt(normalized) > 0n ? normalized : undefined;
    } catch (error) {
      this.log.info(
        ctx,
        `Finalization: local topic mapping is pending for ${contextGraphId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** Apply a graph-scoped envelope on a deployment without the durable recovery inbox. */
  private async processUnjournaledFinalization(
    input: FinalizationRecoveryLiveInput,
  ): Promise<FinalizationRecoveryApplyOutcome> {
    const { msg } = input.candidate;
    const ctx = msg.operationId
      ? createOperationContext('gossip', msg.operationId)
      : createOperationContext('gossip');
    try {
      return await this.recovery.processUnjournaled(input);
    } catch (err) {
      if (err instanceof StoreSchedulerBusyError) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_failed', {
        ...msg,
        contextGraphId: msg.contextGraphId || input.contextGraphId,
        rootEntityCount: msg.rootEntities.length,
        outcome: 'failed',
        retryable: true,
        reason: errMsg,
        level: 'warn',
      }));
      this.log.warn(ctx, `Finalization: failed to process message: ${errMsg}`);
      return 'deferred';
    }
  }

  /**
   * Only graph-scoped finalization is materialized. A message without that
   * scope names root entities instead of the KA's own graph, so this node
   * holds no exact copy to verify it against. Its KA reaches Verified Memory
   * through chain reconcile, which fetches it from peers.
   */
  private ignoreUnscopedFinalization(data: Uint8Array, contextGraphId: string): void {
    const msg = this.decodeFinalizationMessageOrWarn(data);
    // Frames of other gossip message types decode "successfully" with garbage
    // fields (#1100), so only report what plausibly is a finalization.
    if (
      !msg
      || !msg.ual
      || !msg.txHash
      || (msg.contextGraphId && !validateContextGraphId(msg.contextGraphId).valid)
    ) {
      return;
    }
    const ctx = msg.operationId
      ? createOperationContext('gossip', msg.operationId)
      : createOperationContext('gossip');
    const reason = `content scope ${msg.contentScopeVersion ?? 0} is not graph-scoped`;
    this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_unsupported_scope', {
      ...msg,
      contextGraphId: msg.contextGraphId || contextGraphId,
      rootEntityCount: msg.rootEntities.length,
      outcome: 'ignored',
      retryable: false,
      reason,
    }));
    this.log.info(ctx, `Finalization: ignoring ${msg.ual}: ${reason}`);
  }

  /** Resolve and verify the exact RDF state that a graph-scoped command may apply. */
  private async prepareGraphScopedMaterialization(
    input: FinalizationRecoveryLiveInput,
  ): Promise<PreparedGraphScopedMaterialization | undefined> {
    const { candidate: parsed, contextGraphId, sourcePeerId } = input;
    const { msg } = parsed;
    const ctx = msg.operationId
      ? createOperationContext('gossip', msg.operationId)
      : createOperationContext('gossip');
    const subGraphName = msg.subGraphName || undefined;
    const localTopicOnChainContextGraphId =
      await this.resolveLocalTopicOnChainContextGraphId(contextGraphId, ctx);
    const ctxGraphId = await this.resolveFinalizationContextGraphId(
      contextGraphId,
      msg.targetContextGraphId || undefined,
      parsed.kaId,
      ctx,
      localTopicOnChainContextGraphId,
    );
    const {
      scope,
      publicTripleCount,
      privateTripleCount,
      privateMerkleRoot,
      wireAccessPolicy,
      allowedPeers,
    } = parsed;

    const graphManager = new GraphManager(this.store);
    let head;
    try {
      head = await resolveKnowledgeAssetWorkspaceHead({
        store: this.store,
        graphManager,
        contextGraphId,
        kaUal: scope.ual,
        subGraphName,
      });
    } catch (err) {
      if (!(err instanceof KnowledgeAssetWorkspaceHeadCorruptError)) throw err;
      this.log.warn(
        ctx,
        `Finalization: corrupt graph-scoped SWM head for ${scope.ual}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    if (
      !head
      || head.assertionVersion !== scope.assertionVersion
      || head.publicTripleCount !== publicTripleCount
      || head.privateTripleCount !== privateTripleCount
      || (head.privateMerkleRoot?.toLowerCase() ?? undefined)
        !== (privateMerkleRoot ? ethers.hexlify(privateMerkleRoot).toLowerCase() : undefined)
    ) {
      this.log.warn(ctx, `Finalization: no matching graph-scoped SWM head for ${scope.ual}`);
      return undefined;
    }
    const trustedWireAccess = wireAccessPolicy !== undefined
      && sourcePeerId !== undefined
      && sourcePeerId === head.publisherPeerId;
    if (wireAccessPolicy !== undefined && !trustedWireAccess) {
      this.log.warn(
        ctx,
        `Finalization: ignoring untrusted access envelope for ${scope.ual}; ` +
          `source=${sourcePeerId ?? '(missing)'} owner=${head.publisherPeerId}`,
      );
    }
    // Alias comparison needs the canonical effective policy even when legacy
    // metadata omitted the row. Finalization must separately preserve that
    // omission: only an explicitly durable policy outranks an authenticated
    // publisher envelope carried by the finalization message.
    const requestedAccess: GraphScopedAccessEnvelope | undefined = head.access.kind === 'persisted'
      ? head.access
      : trustedWireAccess && wireAccessPolicy !== undefined
        ? { accessPolicy: wireAccessPolicy, allowedPeers }
        : undefined;

    const vmVerification = await this.verifyExactGraphScopedLayer({
      contextGraphId,
      scope,
      layer: MemoryLayer.VerifiableMemory,
      publicTripleCount,
      privateMerkleRoot,
      expectedMerkleRoot: msg.kcMerkleRoot,
      expectedPublicQuadsDigest: head.publicQuadsDigest,
      subGraphName,
    });
    let layerVerification = vmVerification;
    if (layerVerification.status !== 'verified') {
      layerVerification = await this.verifyExactGraphScopedLayer({
        contextGraphId,
        scope,
        layer: MemoryLayer.SharedWorkingMemory,
        publicTripleCount,
        privateMerkleRoot,
        expectedMerkleRoot: msg.kcMerkleRoot,
        expectedPublicQuadsDigest: head.publicQuadsDigest,
        subGraphName,
      });
      if (layerVerification.status === 'count-mismatch') {
        this.log.warn(
          ctx,
          `Finalization: graph-scoped SWM count mismatch for ${scope.ual}: `
            + `wire=${publicTripleCount}, store=${layerVerification.actualCount}`,
        );
        return undefined;
      }
      if (layerVerification.status === 'merkle-mismatch') {
        this.log.warn(ctx, `Finalization: graph-scoped Merkle mismatch for ${scope.ual}`);
        return undefined;
      }
      if (layerVerification.status === 'head-mismatch') {
        this.log.warn(ctx, `Finalization: graph-scoped content does not match its durable head for ${scope.ual}`);
        return undefined;
      }
    }

    const materializationHead: GraphScopedMaterializationEnvelope = {
      publicTripleCount: head.publicTripleCount,
      privateMerkleRoot: head.privateMerkleRoot,
      privateTripleCount: head.privateTripleCount,
      publisherPeerId: head.publisherPeerId,
      access: head.access,
    };
    const verifiedAccess = resolveGraphScopedAccessEnvelope(
      materializationHead,
      requestedAccess,
    );
    return {
      candidate: parsed,
      contextGraphId,
      ...(ctxGraphId ? { ctxGraphId, onChainContextGraphId: ctxGraphId } : {}),
      ...(localTopicOnChainContextGraphId
        ? { localTopicOnChainContextGraphId }
        : {}),
      ...(subGraphName ? { subGraphName, workspaceSubGraphName: subGraphName } : {}),
      ctx,
      head: materializationHead,
      vmVerification,
      layerVerification,
      ...(head.publicQuadsDigest ? { publicQuadsDigest: head.publicQuadsDigest } : {}),
      publisherPeerId: head.publisherPeerId,
      access: verifiedAccess,
    };
  }

  /** Atomically apply a recovery-verified graph-scoped command. */
  private async applyPreparedGraphScopedMaterialization(input: {
    prepared: PreparedGraphScopedMaterialization;
    blockNumber: number;
    txIndex: number;
    authorAddress?: string;
  }): Promise<FinalizationRecoveryApplyOutcome> {
    const {
      prepared,
      blockNumber: verifiedBlockNumber,
      txIndex: verifiedTxIndex,
      authorAddress: verifiedAuthorAddress,
    } = input;
    const {
      candidate: parsed,
      contextGraphId,
      subGraphName,
      ctx,
      head,
      vmVerification,
      layerVerification,
      access,
    } = prepared;
    const { msg } = parsed;
    const {
      scope,
      batchId,
      publicTripleCount,
      privateTripleCount,
      privateMerkleRoot,
    } = parsed;
    const dedupeKey = `${scope.ual}:${msg.txHash}`;
    const materializedVersion = {
      blockNumber: verifiedBlockNumber,
      txIndex: verifiedTxIndex,
    };
    if (vmVerification.status === 'verified') {
      const metadataState = await this.graphScopedMetadataState({
        contextGraphId,
        scope,
        head,
        merkleRoot: msg.kcMerkleRoot,
        batchId,
        expectedTxHash: msg.txHash,
        materializedVersion,
        access,
        authorAddress: verifiedAuthorAddress,
        subGraphName,
      });
      if (metadataState === 'matching') {
        await this.reconcileConfirmedSwmTwin({
          contextGraphId,
          scope,
          head,
          verification: layerVerification,
          expectedMerkleRoot: msg.kcMerkleRoot,
          subGraphName,
          ctx,
        });
        this.markProcessed(dedupeKey);
        this.log.info(ctx, `Finalization: graph-scoped KA ${scope.ual} is already confirmed`);
        return 'already-confirmed';
      }
    }

    const outcome = await this.applyVerifiedGraphScopedFinalization({
      contextGraphId,
      scope,
      verifiedQuads: layerVerification.quads,
      head,
      privateMerkleRoot,
      computedMerkleRoot: layerVerification.merkleRoot,
      batchId,
      authorAddress: verifiedAuthorAddress,
      confirmation: {
        kind: 'transaction',
        txHash: msg.txHash,
        publisherAddress: msg.publisherAddress,
        blockNumber: verifiedBlockNumber,
        materializedVersion,
      },
      access,
      subGraphName,
      source: 'finalization',
      contentAlreadyMaterialized: vmVerification.status === 'verified',
      ctx,
    });
    if (outcome === 'stale') {
      this.markProcessed(dedupeKey);
      this.log.info(ctx, `Finalization: newer graph-scoped assertion already materialized for ${scope.ual}`);
      return 'already-confirmed';
    }

    await this.reconcileConfirmedSwmTwin({
      contextGraphId,
      scope,
      head,
      verification: layerVerification,
      expectedMerkleRoot: msg.kcMerkleRoot,
      subGraphName,
      ctx,
    });

    this.markProcessed(dedupeKey);
    this.log.info(
      ctx,
      `Finalization: promoted graph-scoped KA ${scope.ual} (${publicTripleCount} public, ${privateTripleCount} private)`,
    );
    return 'applied';
  }

  /** Remove only the VM assertion still owned by permanently invalid receipt evidence. */
  private async invalidateVerifiedGraphScopedFinalization(input: {
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    evidence: VerifiedGraphScopedFinalizationEvidence;
    reason: string;
  }): Promise<FinalizationRecoveryInvalidationOutcome> {
    const {
      entry,
      candidate,
      evidence,
      reason,
    } = input;
    const { scope } = candidate;
    const contextGraphId = entry.contextGraphId;
    const subGraphName = evidence.subGraphName;
    const vmGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      scope,
      subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const head: GraphScopedMaterializationEnvelope = {
      publicTripleCount: evidence.publicTripleCount,
      ...(evidence.privateMerkleRoot
        ? { privateMerkleRoot: evidence.privateMerkleRoot }
        : {}),
      privateTripleCount: evidence.privateTripleCount,
      publisherPeerId: evidence.publisherPeerId,
      access: {
        kind: 'persisted',
        accessPolicy: evidence.accessPolicy,
        allowedPeers: [...evidence.allowedPeers],
      },
    };
    const outcome = await withMaterializationLock(metaGraph, scope.ual, async () => {
      const metadataState = await this.graphScopedMetadataState({
        contextGraphId,
        scope,
        head,
        merkleRoot: candidate.msg.kcMerkleRoot,
        batchId: candidate.batchId,
        expectedTxHash: evidence.transactionHash,
        materializedVersion: {
          blockNumber: evidence.blockNumber,
          txIndex: evidence.txIndex,
        },
        access: {
          accessPolicy: evidence.accessPolicy,
          allowedPeers: evidence.allowedPeers,
        },
        authorAddress: evidence.authorAddress,
        subGraphName,
      });
      if (metadataState === 'absent') return 'already-absent' as const;
      if (metadataState === 'different') return 'stale-target' as const;
      const replaced = await tryReplaceGraphAndSubjectAtomically(
        this.store,
        vmGraph,
        [],
        metaGraph,
        scope.ual,
        [],
        { source: 'agent.finalization.graphScopedCanonicalInvalidation' },
      );
      return replaced ? 'invalidated' as const : 'deferred' as const;
    });
    if (outcome === 'invalidated') {
      this.eventBus?.emit(DKGEvent.MEMORY_GRAPH_CHANGED, {
        contextGraphId,
        layers: ['vm'],
        subGraphName,
        operation: 'verifiable_memory_invalidated',
        source: 'chain-reconcile',
        counts: { roots: 0, triples: evidence.publicTripleCount },
      });
      this.log.warn(
        createOperationContext('sync'),
        `Retracted graph-scoped VM assertion ${scope.ual}: ${reason}`,
      );
    }
    return outcome;
  }

  /** Load and verify one exact graph-scoped layer using the shared count/root rules. */
  private async verifyExactGraphScopedLayer(input: {
    contextGraphId: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    layer: MemoryLayer.SharedWorkingMemory | MemoryLayer.VerifiableMemory;
    publicTripleCount: number;
    privateMerkleRoot?: Uint8Array;
    expectedMerkleRoot: Uint8Array;
    expectedPublicQuadsDigest?: string;
    subGraphName?: string;
  }): Promise<ExactGraphScopedLayerVerification> {
    const graphUri = knowledgeAssetLayerGraphUri(
      input.contextGraphId,
      input.layer,
      input.scope,
      input.subGraphName,
    );
    return verifyExactGraphContent(this.store, {
      graphUri,
      publicTripleCount: input.publicTripleCount,
      ...(input.privateMerkleRoot
        ? { privateMerkleRoot: input.privateMerkleRoot }
        : {}),
      expectedMerkleRoot: input.expectedMerkleRoot,
      ...(input.expectedPublicQuadsDigest
        ? { expectedPublicQuadsDigest: input.expectedPublicQuadsDigest }
        : {}),
      source: 'agent.finalization.verifyExactLayer',
    });
  }

  /** Recognize exact confirmed VM state from surviving immutable metadata. */
  private async reconcileConfirmedGraphScopedVmWithoutWorkspaceHead(input: {
    contextGraphId: string;
    ual: string;
    assertionVersion?: bigint;
    merkleRoot: Uint8Array;
    kaId: bigint;
    batchId: bigint;
    versionBlock: number;
    subGraphName?: string;
  }, ctx: OperationContext): Promise<'already-confirmed' | 'no-swm' | undefined> {
    const resolution = await resolveConfirmedGraphScopedVm(this.store, {
      contextGraphId: input.contextGraphId,
      ual: input.ual,
      ...(input.assertionVersion === undefined
        ? {}
        : { assertionVersion: input.assertionVersion }),
      merkleRoot: input.merkleRoot,
      kaId: input.kaId,
      batchId: input.batchId,
      ...(input.subGraphName ? { subGraphName: input.subGraphName } : {}),
    });
    if (resolution.status === 'absent') return undefined;
    if (resolution.status === 'invalid') {
      if (resolution.reason === 'not-current') {
        // An intact copy of an earlier version: the caller fetches the current one.
        this.log.info(
          ctx,
          `Chain-reconcile: confirmed graph-scoped VM for ${input.ual} is not the current version`,
        );
      } else {
        this.log.warn(
          ctx,
          `Chain-reconcile: confirmed graph-scoped VM is invalid for ${input.ual} `
            + `(${resolution.reason})`,
        );
      }
      return 'no-swm';
    }

    await this.advanceExactGraphScopedVersion({
      contextGraphId: input.contextGraphId,
      scope: resolution.scope,
      materializedVersion: { blockNumber: input.versionBlock, txIndex: 0 },
    });
    // Exact VM recovery stages the fetched public assertion in graph-scoped
    // SWM before atomically materializing VM. Without a mutable workspace head,
    // that graph is an orphaned transport twin, not a live SWM asset. Retire it
    // only after the immutable VM envelope and chain binding have both verified.
    // A cleanup failure propagates so the ordinal retries rather than caching a
    // contaminated success.
    const retire = this.retireConfirmedGraphScopedSwmTwinIfOrphaned;
    if (retire !== undefined) {
      const candidate = Object.freeze({
        contextGraphId: input.contextGraphId,
        ual: resolution.scope.ual,
        agentAddress: resolution.scope.agentAddress,
        kaNumber: BigInt(resolution.scope.kaNumber),
        assertionVersion: BigInt(resolution.envelope.assertionVersion),
        ...(input.subGraphName ? { subGraphName: input.subGraphName } : {}),
      });
      try {
        await retire(candidate, ctx);
      } catch (err) {
        // Retirement re-reads the head under the SWM lock. A corrupt head it
        // cannot prove stale is this KA's own damage, and retrying the ordinal
        // cannot repair it: keep the head and the verified VM result, so one
        // KA never fails the caller's whole sweep. Every other cleanup failure
        // still propagates.
        if (!isKnowledgeAssetWorkspaceHeadCorruptError(err)) throw err;
        this.log.warn(
          ctx,
          `Chain-reconcile: kept corrupt graph-scoped SWM head for ${input.ual}; `
            + `its SWM twin was not retired: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.log.info(
      ctx,
      `Chain-reconcile: exact confirmed VM state survives without a workspace head for ${input.ual}`,
    );
    return 'already-confirmed';
  }

  /** Recover canonical receipt evidence from an exact, receipt-backed VM assertion. */
  private async recoverVerifiedGraphScopedEvidenceFromConfirmedVm(input: {
    replay: {
      contextGraphId: string;
      onChainCgId: string;
      ual: string;
      merkleRoot: string;
      kaId: string;
    };
    candidate: ParsedGraphScopedFinalization;
  }): Promise<VerifiedGraphScopedFinalizationEvidence | undefined> {
    const { replay, candidate } = input;
    let kaId: bigint;
    let onChainContextGraphId: bigint;
    try {
      kaId = BigInt(replay.kaId);
      onChainContextGraphId = BigInt(replay.onChainCgId);
      if (kaId !== candidate.kaId || onChainContextGraphId <= 0n) return undefined;
    } catch {
      return undefined;
    }

    const resolution = await resolveConfirmedGraphScopedVm(this.store, {
      contextGraphId: replay.contextGraphId,
      ual: replay.ual,
      merkleRoot: ethers.getBytes(replay.merkleRoot),
      kaId,
      batchId: candidate.batchId,
      ...(candidate.msg.subGraphName
        ? { subGraphName: candidate.msg.subGraphName }
        : {}),
    });
    if (resolution.status !== 'verified') return undefined;

    const { envelope } = resolution;
    if (
      envelope.transactionHash?.toLowerCase() !== candidate.msg.txHash.toLowerCase()
      || envelope.assertionVersion !== candidate.assertionVersion
      || envelope.publicTripleCount !== candidate.publicTripleCount
      || envelope.privateTripleCount !== candidate.privateTripleCount
      || (envelope.privateMerkleRoot
        ? ethers.hexlify(envelope.privateMerkleRoot).toLowerCase()
        : undefined) !== (candidate.privateMerkleRoot
        ? ethers.hexlify(candidate.privateMerkleRoot).toLowerCase()
        : undefined)
      || envelope.batchId !== candidate.batchId
    ) return undefined;

    const recovery = await recoverReceiptBackedGraphScopedEvidence({
      store: this.store,
      chain: this.chain,
      contextGraphId: replay.contextGraphId,
      scope: resolution.scope,
      head: {
        kaUal: replay.ual,
        assertionVersion: envelope.assertionVersion,
        publicQuadsDigest: resolution.publicQuadsDigest,
        publicTripleCount: envelope.publicTripleCount,
        ...(envelope.privateMerkleRoot
          ? { privateMerkleRoot: ethers.hexlify(envelope.privateMerkleRoot) }
          : {}),
        privateTripleCount: envelope.privateTripleCount,
      },
      merkleRoot: envelope.merkleRoot,
      publisherAddress: candidate.msg.publisherAddress,
      kaId,
      batchId: candidate.batchId,
      onChainContextGraphId,
      ...(envelope.subGraphName ? { subGraphName: envelope.subGraphName } : {}),
    });
    return recovery.status === 'recovered' ? recovery.evidence : undefined;
  }

  /**
   * Resolve and promote the exact graph-scoped SWM assertion for a chain-known
   * KA. `undefined` means no V2 head exists and the caller answers `no-swm`;
   * every other result is authoritative for V2.
   */
  private async reconcileGraphScopedKC(input: {
    contextGraphId: string;
    onChainCgId?: string;
    ual: string;
    assertionVersion?: bigint;
    merkleRoot: Uint8Array;
    publisherAddress: string;
    kaId: bigint;
    batchId: bigint;
    versionBlock: number;
    authorAddress?: string;
    versionSnapshot?: PublicFinalizedMaterializationVersionSnapshot;
    signal?: AbortSignal;
    subGraphName?: string;
    trustedAssertionEvidence?: TrustedGraphScopedAssertionEvidence;
  }, ctx: OperationContext): Promise<
    | 'promoted'
    | 'already-confirmed'
    | 'no-swm'
    | 'stale-target'
    | 'verified-vm-metadata-pending'
    | undefined
  > {
    const {
      contextGraphId,
      onChainCgId,
      ual,
      assertionVersion,
      merkleRoot,
      publisherAddress,
      kaId,
      batchId,
      versionBlock,
      authorAddress,
      versionSnapshot,
      signal,
      subGraphName,
      trustedAssertionEvidence,
    } = input;
    // Historical UAL shapes cannot name a V2 per-KA graph. Do not let the
    // strict V2 parser turn those into a terminal "corrupt head" result.
    try {
      createGraphKnowledgeAssetScope(ual, 1);
    } catch {
      return undefined;
    }
    const graphManager = new GraphManager(this.store);
    let workspaceHead: KnowledgeAssetWorkspaceHead | undefined;
    try {
      workspaceHead = await resolveKnowledgeAssetWorkspaceHead({
        store: this.store,
        graphManager,
        contextGraphId,
        kaUal: ual,
        subGraphName,
      });
    } catch (err) {
      if (!(err instanceof KnowledgeAssetWorkspaceHeadCorruptError)) throw err;
      this.log.warn(
        ctx,
        `Chain-reconcile: corrupt graph-scoped SWM head for ${ual}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!trustedAssertionEvidence) {
        // A corrupt mutable workspace head must not hide an independently
        // authenticated VM copy. Exact RFC64 fetch can already have verified
        // and atomically materialized the requested assertion before this
        // post-fetch check runs. Re-read the immutable confirmed envelope and
        // verify the exact VM graph against current chain truth. This remains
        // fail-closed: absent, invalid, stale, or root-mismatched VM state is
        // still reported as no-swm.
        return (await this.reconcileConfirmedGraphScopedVmWithoutWorkspaceHead({
          contextGraphId,
          ual,
          assertionVersion,
          merkleRoot,
          kaId,
          batchId,
          versionBlock,
          ...(subGraphName ? { subGraphName } : {}),
        }, ctx)) ?? 'no-swm';
      }
      // Named recovery carries receipt/seal-validated immutable evidence. A
      // torn mutable head must not block exact recovery of that assertion.
    }
    if (!workspaceHead && !trustedAssertionEvidence) {
      return this.reconcileConfirmedGraphScopedVmWithoutWorkspaceHead({
        contextGraphId,
        ual,
        assertionVersion,
        merkleRoot,
        kaId,
        batchId,
        versionBlock,
        ...(subGraphName ? { subGraphName } : {}),
      }, ctx);
    }

    let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    try {
      scope = createGraphKnowledgeAssetScope(
        ual,
        trustedAssertionEvidence?.assertionVersion ?? workspaceHead!.assertionVersion,
      );
    } catch (err) {
      this.log.warn(
        ctx,
        `Chain-reconcile: invalid graph-scoped identity for ${ual}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'no-swm';
    }
    const head: GraphScopedMaterializationEnvelope = trustedAssertionEvidence
      ? {
          publicTripleCount: trustedAssertionEvidence.publicTripleCount,
          ...(trustedAssertionEvidence.privateMerkleRoot
            ? { privateMerkleRoot: trustedAssertionEvidence.privateMerkleRoot }
            : {}),
          privateTripleCount: trustedAssertionEvidence.privateTripleCount,
          publisherPeerId: trustedAssertionEvidence.publisherPeerId,
          access: {
            kind: 'persisted',
            accessPolicy: trustedAssertionEvidence.accessPolicy,
            allowedPeers: [...trustedAssertionEvidence.allowedPeers],
          },
        }
      : {
          publicTripleCount: workspaceHead!.publicTripleCount,
          privateMerkleRoot: workspaceHead!.privateMerkleRoot,
          privateTripleCount: workspaceHead!.privateTripleCount,
          publisherPeerId: workspaceHead!.publisherPeerId,
          access: workspaceHead!.access,
        };
    const evidencePublisherAddress = trustedAssertionEvidence?.publisherAddress ?? publisherAddress;
    const evidenceAuthorAddress = trustedAssertionEvidence?.authorAddress ?? authorAddress;
    const evidenceBlockNumber = trustedAssertionEvidence?.blockNumber ?? versionBlock;
    const materializedVersion = trustedAssertionEvidence
      ? { blockNumber: trustedAssertionEvidence.blockNumber, txIndex: trustedAssertionEvidence.txIndex }
      : { blockNumber: versionBlock, txIndex: 0 };
    const preserveNewerWorkspaceLifecycle = trustedAssertionEvidence !== undefined
      && workspaceHead !== undefined
      && BigInt(workspaceHead.assertionVersion)
        > BigInt(trustedAssertionEvidence.assertionVersion);
    const packedKaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
    if (
      scope.ual !== ual
      || packedKaId !== kaId
      || (assertionVersion !== undefined
        && !sameBigIntLiteral(scope.assertionVersion, assertionVersion))
    ) {
      this.log.warn(
        ctx,
        `Chain-reconcile: local graph-scoped identity or assertion version does not match `
          + `current chain identity for ${ual}`,
      );
      return 'no-swm';
    }
    const reconciliationBatchId = batchId;
    if (head.publicTripleCount === 0 && head.privateTripleCount === 0) {
      this.log.warn(ctx, `Chain-reconcile: empty graph-scoped content envelope for ${ual}`);
      return 'no-swm';
    }

    let privateMerkleRoot: Uint8Array | undefined;
    try {
      privateMerkleRoot = head.privateMerkleRoot
        ? ethers.getBytes(head.privateMerkleRoot)
        : undefined;
    } catch {
      this.log.warn(ctx, `Chain-reconcile: invalid private commitment for graph-scoped KA ${ual}`);
      return 'no-swm';
    }
    const vmVerification = await this.verifyExactGraphScopedLayer({
      contextGraphId,
      scope,
      layer: MemoryLayer.VerifiableMemory,
      publicTripleCount: head.publicTripleCount,
      privateMerkleRoot,
      expectedMerkleRoot: merkleRoot,
      expectedPublicQuadsDigest: trustedAssertionEvidence
        ? trustedAssertionEvidence.publicQuadsDigest
        : workspaceHead?.publicQuadsDigest,
      subGraphName,
    });
    if (vmVerification.status === 'verified') {
      const access = resolveGraphScopedAccessEnvelope(
        head,
        trustedAssertionEvidence
          ? {
              accessPolicy: trustedAssertionEvidence.accessPolicy,
              allowedPeers: trustedAssertionEvidence.allowedPeers,
            }
          : undefined,
      );
      const metadataState = await this.graphScopedMetadataState({
        contextGraphId,
        scope,
        head,
        merkleRoot,
        batchId: reconciliationBatchId,
        expectedTxHash: trustedAssertionEvidence?.transactionHash,
        access,
        confirmationKind: 'transaction',
        authorAddress: evidenceAuthorAddress,
        subGraphName,
      });
      if (metadataState === 'matching') {
        await this.advanceExactGraphScopedVersion({
          contextGraphId,
          scope,
          materializedVersion,
        });
        await this.reconcileConfirmedSwmTwin({
          contextGraphId,
          scope,
          head,
          verification: vmVerification,
          expectedMerkleRoot: merkleRoot,
          subGraphName,
          ctx,
        });
        this.log.info(ctx, `Chain-reconcile: ${ual} already has exact VM content and metadata`);
        return preserveNewerWorkspaceLifecycle ? 'stale-target' : 'already-confirmed';
      }
      if (!trustedAssertionEvidence && access.accessPolicy !== 'ownerOnly') {
        const failClosedMetadataState = await this.graphScopedMetadataState({
          contextGraphId,
          scope,
          head,
          merkleRoot,
          batchId: reconciliationBatchId,
          access: { accessPolicy: 'ownerOnly', allowedPeers: [] },
          confirmationKind: 'transaction',
          authorAddress,
          subGraphName,
        });
        if (failClosedMetadataState === 'matching') {
          await this.advanceExactGraphScopedVersion({
            contextGraphId,
            scope,
            materializedVersion,
          });
          await this.reconcileConfirmedSwmTwin({
            contextGraphId,
            scope,
            head,
            verification: vmVerification,
            expectedMerkleRoot: merkleRoot,
            subGraphName,
            ctx,
          });
          this.log.info(
            ctx,
            `Chain-reconcile: ${ual} retains fail-closed access without assertion evidence`,
          );
          return 'already-confirmed';
        }
      }
      if (!trustedAssertionEvidence) {
        let onChainContextGraphId: bigint;
        try {
          if (!onChainCgId) throw new Error('missing on-chain context graph id');
          onChainContextGraphId = BigInt(onChainCgId);
          if (onChainContextGraphId < 0n) throw new Error('negative on-chain context graph id');
        } catch {
          this.log.info(
            ctx,
            `Chain-reconcile: exact VM metadata for ${ual} cannot be repaired without `
              + 'a valid on-chain context graph id; deferring',
          );
          return 'verified-vm-metadata-pending';
        }
        const recovery = await recoverReceiptBackedGraphScopedEvidence({
          store: this.store,
          chain: this.chain,
          contextGraphId,
          scope,
          head: workspaceHead!,
          merkleRoot,
          publisherAddress,
          kaId,
          batchId: reconciliationBatchId,
          onChainContextGraphId,
          subGraphName,
        });
        if (recovery.status === 'recovered') {
          this.log.info(
            ctx,
            `Chain-reconcile: recovered canonical transaction provenance and verified `
              + `access controls for ${scope.ual}`,
          );
          return this.repairExactGraphScopedVmMetadata({
            contextGraphId,
            scope,
            verifiedQuads: vmVerification.quads,
            computedMerkleRoot: vmVerification.merkleRoot,
            evidence: recovery.evidence,
            privateMerkleRoot,
            batchId: reconciliationBatchId,
            preserveNewerWorkspaceLifecycle: false,
            ctx,
          });
        }
        return this.applyPublicFinalizedMaterialization({
          contextGraphId,
          onChainCgId,
          scope,
          head,
          privateMerkleRoot,
          merkleRoot,
          batchId: reconciliationBatchId,
          versionBlock,
          versionSnapshot,
          signal,
          subGraphName,
          verifiedLayer: {
            layer: MemoryLayer.VerifiableMemory,
            verification: vmVerification,
          },
          unavailableReason: `trusted receipt provenance (${recovery.reason})`,
          ctx,
        });
      }
      // A confirmed publish may have committed the exact VM graph before its
      // graph-scoped metadata survived a crash. Reapply only the metadata tail:
      // SWM writers use a different lock, so this recovery path must not delete
      // a potentially newer staged assertion.
      return this.repairExactGraphScopedVmMetadata({
        contextGraphId,
        scope,
        verifiedQuads: vmVerification.quads,
        computedMerkleRoot: vmVerification.merkleRoot,
        evidence: trustedAssertionEvidence,
        privateMerkleRoot,
        batchId: reconciliationBatchId,
        preserveNewerWorkspaceLifecycle,
        ctx,
      });
    }

    const swmVerification = await this.verifyExactGraphScopedLayer({
      contextGraphId,
      scope,
      layer: MemoryLayer.SharedWorkingMemory,
      publicTripleCount: head.publicTripleCount,
      privateMerkleRoot,
      expectedMerkleRoot: merkleRoot,
      expectedPublicQuadsDigest: trustedAssertionEvidence
        ? trustedAssertionEvidence.publicQuadsDigest
        : workspaceHead?.publicQuadsDigest,
      subGraphName,
    });
    if (swmVerification.status === 'count-mismatch') {
      this.log.info(
        ctx,
        `Chain-reconcile: graph-scoped SWM count mismatch for ${ual}: `
          + `head=${head.publicTripleCount}, store=${swmVerification.actualCount}`,
      );
      return 'no-swm';
    }
    if (swmVerification.status === 'merkle-mismatch') {
      this.log.info(
        ctx,
        `Chain-reconcile: exact graph-scoped SWM assertion does not match the chain root for ${ual}`,
      );
      return 'no-swm';
    }
    if (swmVerification.status === 'head-mismatch') {
      this.log.info(
        ctx,
        `Chain-reconcile: graph-scoped content does not match its durable head for ${ual}`,
      );
      return 'no-swm';
    }

    // Public VM inventory is the chain itself. Once the current chain binding,
    // liveness, public policy, root count and exact local SWM projection all
    // agree, materialize through the explicit receiptless confirmation lane.
    // This does not invent transaction provenance: metadata records
    // `finalized-materialization` and deliberately omits transactionHash.
    // Private/unknown CGs still require assertion-specific receipt evidence.
    if (!trustedAssertionEvidence) {
      return this.applyPublicFinalizedMaterialization({
        contextGraphId,
        onChainCgId,
        scope,
        head,
        privateMerkleRoot,
        merkleRoot,
        batchId: reconciliationBatchId,
        versionBlock,
        versionSnapshot,
        signal,
        subGraphName,
        verifiedLayer: {
          layer: MemoryLayer.SharedWorkingMemory,
          verification: swmVerification,
        },
        ctx,
      });
    }

    const outcome = await this.applyVerifiedGraphScopedFinalization({
      contextGraphId,
      scope,
      verifiedQuads: swmVerification.quads,
      head,
      privateMerkleRoot,
      computedMerkleRoot: swmVerification.merkleRoot,
      batchId: reconciliationBatchId,
      authorAddress: evidenceAuthorAddress,
      confirmation: {
        kind: 'transaction',
        txHash: trustedAssertionEvidence.transactionHash,
        publisherAddress: evidencePublisherAddress,
        blockNumber: evidenceBlockNumber,
        materializedVersion,
      },
      ...(trustedAssertionEvidence
        ? {
            access: {
              accessPolicy: trustedAssertionEvidence.accessPolicy,
              allowedPeers: trustedAssertionEvidence.allowedPeers,
            },
          }
        : {}),
      subGraphName,
      source: 'chain-reconcile',
      ctx,
    });
    if (outcome === 'stale') return 'stale-target';
    if (outcome === 'preserved-metadata') {
      this.log.info(
        ctx,
        `Chain-reconcile: materialized exact content while retaining older same-root metadata for ${ual}`,
      );
      return preserveNewerWorkspaceLifecycle ? 'stale-target' : 'already-confirmed';
    }
    this.log.info(
      ctx,
      `Chain-reconcile: promoted exact graph-scoped SWM assertion to VM for ${ual} (ka=${kaId})`,
    );
    return preserveNewerWorkspaceLifecycle ? 'stale-target' : 'promoted';
  }

  /**
   * Apply one exact public assertion after chain authority has been proven.
   * Receiptless VM repair and SWM promotion intentionally share this policy so
   * their authority fence and finalized metadata shape cannot drift apart.
   */
  private async applyPublicFinalizedMaterialization(input: {
    contextGraphId: string;
    onChainCgId?: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    head: GraphScopedMaterializationEnvelope;
    privateMerkleRoot?: Uint8Array;
    merkleRoot: Uint8Array;
    batchId: bigint;
    versionBlock: number;
    versionSnapshot?: PublicFinalizedMaterializationVersionSnapshot;
    signal?: AbortSignal;
    subGraphName?: string;
    verifiedLayer: VerifiedPublicFinalizedLayer;
    /** VM repair keeps the receipt recovery diagnostic in its defer log. */
    unavailableReason?: string;
    ctx: OperationContext;
  }): Promise<PublicFinalizedMaterializationOutcome> {
    const {
      contextGraphId,
      onChainCgId,
      scope,
      head,
      privateMerkleRoot,
      merkleRoot,
      batchId,
      versionBlock,
      versionSnapshot,
      signal,
      subGraphName,
      verifiedLayer,
      unavailableReason,
      ctx,
    } = input;
    const contentAlreadyMaterialized = verifiedLayer.layer === MemoryLayer.VerifiableMemory;
    const publicAuthorityResult = await resolvePublicFinalizedMaterializationAuthority({
      chain: this.chain,
      onChainContextGraphId: onChainCgId,
      kaId: batchId,
      assertionVersion: scope.assertionVersion,
      merkleRoot,
      versionBlock,
      versionSnapshot,
      signal,
    });
    if (publicAuthorityResult.kind === 'unavailable') {
      if (publicAuthorityResult.detail) {
        this.log.info(
          ctx,
          `Chain-reconcile: public finalized authority is unavailable for ${scope.ual}: `
            + publicAuthorityResult.detail,
        );
      }
      if (contentAlreadyMaterialized) {
        this.log.info(
          ctx,
          `Chain-reconcile: exact VM metadata for ${scope.ual} cannot be repaired without `
            + `${unavailableReason ?? 'public chain authority'}; deferring`,
        );
      } else {
        this.log.info(
          ctx,
          `Chain-reconcile: exact SWM content for ${scope.ual} is verified but neither `
            + 'transaction provenance nor public chain authority is available; deferring VM promotion',
        );
      }
      return 'verified-vm-metadata-pending';
    }
    if (publicAuthorityResult.authorUnavailableReason) {
      this.log.info(
        ctx,
        `Chain-reconcile: latest-root author is unavailable for ${scope.ual}: `
          + publicAuthorityResult.authorUnavailableReason,
      );
    }
    const publicAuthority = publicAuthorityResult;

    const finalizedHead: GraphScopedMaterializationEnvelope = {
      ...head,
      publisherPeerId: CHAIN_FINALIZED_RECONCILE_PEER_ID,
      access: { kind: 'persisted', accessPolicy: 'public', allowedPeers: [] },
    };
    const finalizedVersion = { blockNumber: versionBlock, txIndex: 0 };

    // An exact VM graph may already have a complete receiptless envelope. In
    // that case only the ordering watermark needs to advance. SWM content has
    // no VM metadata yet and proceeds directly to the shared atomic apply.
    if (contentAlreadyMaterialized) {
      const finalizedMetadataState = await this.graphScopedMetadataState({
        contextGraphId,
        scope,
        head: finalizedHead,
        merkleRoot,
        batchId,
        materializedVersion: finalizedVersion,
        access: { accessPolicy: 'public', allowedPeers: [] },
        confirmationKind: 'finalized-materialization',
        authorAddress: publicAuthority.authorAddress,
        subGraphName,
      });
      if (finalizedMetadataState === 'matching') {
        await this.advanceExactGraphScopedVersion({
          contextGraphId,
          scope,
          materializedVersion: finalizedVersion,
        });
        await this.reconcileConfirmedSwmTwin({
          contextGraphId,
          scope,
          head: finalizedHead,
          verification: verifiedLayer.verification,
          expectedMerkleRoot: merkleRoot,
          subGraphName,
          ctx,
        });
        this.log.info(
          ctx,
          `Chain-reconcile: ${scope.ual} already has exact receiptless public VM state`,
        );
        return 'already-confirmed';
      }
    }

    const outcome = await this.applyVerifiedGraphScopedFinalization({
      contextGraphId,
      scope,
      verifiedQuads: verifiedLayer.verification.quads,
      head: finalizedHead,
      privateMerkleRoot,
      computedMerkleRoot: verifiedLayer.verification.merkleRoot,
      batchId,
      authorAddress: publicAuthority.authorAddress,
      confirmation: {
        kind: 'finalized-materialization',
        materializedVersion: finalizedVersion,
      },
      access: { accessPolicy: 'public', allowedPeers: [] },
      subGraphName,
      source: 'chain-reconcile',
      contentAlreadyMaterialized,
      ctx,
    });
    if (outcome === 'stale') return 'stale-target';

    await this.reconcileConfirmedSwmTwin({
      contextGraphId,
      scope,
      head: finalizedHead,
      verification: verifiedLayer.verification,
      expectedMerkleRoot: merkleRoot,
      subGraphName,
      ctx,
    });

    if (contentAlreadyMaterialized) {
      this.log.info(
        ctx,
        `Chain-reconcile: exact public VM graph already matches ${scope.ual}; `
          + 'repaired receiptless chain metadata',
      );
      return 'already-confirmed';
    }
    if (outcome === 'preserved-metadata') return 'already-confirmed';
    this.log.info(
      ctx,
      `Chain-reconcile: promoted exact public SWM assertion to VM from chain inventory `
        + `for ${scope.ual} (ka=${batchId})`,
    );
    return 'promoted';
  }

  /**
   * Retire an exact graph-scoped SWM twin only after the same assertion has a
   * verified VM projection. The injected owner holds the publisher's per-KA
   * write lock and re-proves the SWM head, VM metadata, counts, commitments,
   * and bytes before deleting anything. This closes the arrival-order race in
   * which chain reconciliation materializes VM after ordinary SWM catch-up:
   * without this tail, the stale SWM graph can make a later RFC-64 cold
   * bootstrap reject an otherwise exact author head forever.
   */
  private async reconcileConfirmedSwmTwin(input: {
    contextGraphId: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    head: GraphScopedMaterializationEnvelope;
    verification: VerifiedGraphScopedLayer;
    expectedMerkleRoot: Uint8Array;
    subGraphName?: string;
    ctx: OperationContext;
  }): Promise<void> {
    const reconcile = this.reconcileConfirmedGraphScopedSwmTwin;
    if (reconcile === undefined) return;
    await reconcile(Object.freeze({
      contextGraphId: input.contextGraphId,
      ...(input.subGraphName === undefined
        ? {}
        : { subGraphName: input.subGraphName }),
      kaUal: input.scope.ual,
      assertionVersion: input.scope.assertionVersion,
      publicQuadsDigest: workspacePublicQuadsDigest(input.verification.quads),
      publicQuadsCount: input.head.publicTripleCount,
      privateTripleCount: input.head.privateTripleCount,
      ...(input.head.privateMerkleRoot === undefined
        ? {}
        : { privateMerkleRoot: input.head.privateMerkleRoot }),
      expectedMerkleRoot: ethers.hexlify(input.expectedMerkleRoot),
    }), input.ctx);
  }

  private async repairExactGraphScopedVmMetadata(input: {
    contextGraphId: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    verifiedQuads: Quad[];
    computedMerkleRoot: Uint8Array;
    evidence: TrustedGraphScopedAssertionEvidence;
    privateMerkleRoot?: Uint8Array;
    batchId: bigint;
    preserveNewerWorkspaceLifecycle: boolean;
    ctx: OperationContext;
  }): Promise<'already-confirmed' | 'stale-target'> {
    const { evidence } = input;
    const head: GraphScopedMaterializationEnvelope = {
      publicTripleCount: evidence.publicTripleCount,
      ...(evidence.privateMerkleRoot
        ? { privateMerkleRoot: evidence.privateMerkleRoot }
        : {}),
      privateTripleCount: evidence.privateTripleCount,
      publisherPeerId: evidence.publisherPeerId,
      access: {
        kind: 'persisted',
        accessPolicy: evidence.accessPolicy,
        allowedPeers: [...evidence.allowedPeers],
      },
    };
    const outcome = await this.applyVerifiedGraphScopedFinalization({
      contextGraphId: input.contextGraphId,
      scope: input.scope,
      verifiedQuads: input.verifiedQuads,
      head,
      privateMerkleRoot: input.privateMerkleRoot,
      computedMerkleRoot: input.computedMerkleRoot,
      batchId: input.batchId,
      authorAddress: evidence.authorAddress,
      confirmation: {
        kind: 'transaction',
        txHash: evidence.transactionHash,
        publisherAddress: evidence.publisherAddress,
        blockNumber: evidence.blockNumber,
        materializedVersion: { blockNumber: evidence.blockNumber, txIndex: evidence.txIndex },
      },
      access: {
        accessPolicy: evidence.accessPolicy,
        allowedPeers: evidence.allowedPeers,
      },
      subGraphName: evidence.subGraphName,
      source: 'chain-reconcile',
      contentAlreadyMaterialized: true,
      ctx: input.ctx,
    });
    if (outcome === 'stale') return 'stale-target';
    if (outcome === 'preserved-metadata') {
      this.log.info(
        input.ctx,
        `Chain-reconcile: retained confirmed metadata for an older same-root assertion `
          + evidence.transactionHash,
      );
      return input.preserveNewerWorkspaceLifecycle ? 'stale-target' : 'already-confirmed';
    }
    this.log.info(
      input.ctx,
      `Chain-reconcile: exact VM graph already matches ${input.scope.ual}; repaired metadata`,
    );
    return input.preserveNewerWorkspaceLifecycle ? 'stale-target' : 'already-confirmed';
  }

  /**
   * Materialize a graph-scoped assertion after its content and chain binding
   * have been verified. Gossip finalization and chain reconciliation deliberately
   * share this VM transition so a late joiner cannot produce a different
   * verified shape from a node that saw the live finalization message. SWM
   * cleanup is deferred to the publisher's per-KA writer lock: this lock cannot
   * safely delete a newer assertion staged after source verification.
   */
  private async applyVerifiedGraphScopedFinalization(input: {
    contextGraphId: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    verifiedQuads: Quad[];
    head: GraphScopedMaterializationEnvelope;
    privateMerkleRoot?: Uint8Array;
    computedMerkleRoot: Uint8Array;
    batchId: bigint;
    authorAddress?: string;
    confirmation: VerifiedGraphScopedConfirmation;
    access?: GraphScopedAccessEnvelope;
    subGraphName?: string;
    source: 'finalization' | 'chain-reconcile';
    contentAlreadyMaterialized?: boolean;
    ctx: OperationContext;
  }): Promise<'applied' | 'stale' | 'preserved-metadata'> {
    const {
      contextGraphId,
      scope,
      verifiedQuads,
      head,
      privateMerkleRoot,
      computedMerkleRoot,
      batchId,
      authorAddress,
      confirmation,
      access: requestedAccess,
      subGraphName,
      source,
      contentAlreadyMaterialized = false,
      ctx,
    } = input;
    const materializedVersion = confirmation.materializedVersion;
    const publicTripleCount = head.publicTripleCount;
    const privateTripleCount = head.privateTripleCount;
    const vmGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      scope,
      subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const safeAccess = resolveGraphScopedAccessEnvelope(head, requestedAccess);

    const outcome = await withMaterializationLock(metaGraph, scope.ual, async () => {
      const currentMaterializedVersion = await readMaterializedVersion(
        this.store,
        metaGraph,
        scope.ual,
      );
      const confirmedAssertionVersion = source === 'chain-reconcile' || contentAlreadyMaterialized
        ? await this.confirmedGraphScopedAssertionVersionForRoot({
          contextGraphId,
          ual: scope.ual,
          merkleRoot: computedMerkleRoot,
        })
        : undefined;
      const incomingVersionIsStale = currentMaterializedVersion !== null
        && compareMaterializedVersion(materializedVersion, currentMaterializedVersion) < 0;
      // A verified receipt may arrive after a sweep observed this same
      // assertion at a later block. Repair that exact metadata while retaining
      // the later ordering stamp. Within one block, however, txIndex provides
      // a total order and an older transaction must not rewrite provenance.
      const canRepairStaleExactMetadata = contentAlreadyMaterialized
        && confirmedAssertionVersion === scope.assertionVersion
        && currentMaterializedVersion !== null
        && materializedVersion.blockNumber < currentMaterializedVersion.blockNumber;
      if (incomingVersionIsStale && !canRepairStaleExactMetadata) {
        return 'stale' as const;
      }
      const preserveConfirmedMetadata = confirmedAssertionVersion !== undefined
        && confirmedAssertionVersion !== scope.assertionVersion;
      const metadataAccessPolicy = source === 'chain-reconcile'
        && requestedAccess === undefined
        ? 'ownerOnly'
        : safeAccess.accessPolicy;
      const metadataAllowedPeers = metadataAccessPolicy === 'allowList'
        ? safeAccess.allowedPeers
        : [];
      // A chain sweep knows the latest root, but not which assertion version or
      // access envelope produced it. Identical-content updates share a root and
      // physical VM graph, so a newer mutable head must not broaden confirmed
      // access metadata without assertion-specific finalization evidence.
      if (preserveConfirmedMetadata) {
        if (!contentAlreadyMaterialized) {
          const vmQuads = verifiedQuads.map((quad) => ({ ...quad, graph: vmGraph }));
          const replaced = await tryReplaceGraphAtomically(
            this.store,
            vmGraph,
            vmQuads,
            { source: 'agent.finalization.graphScopedPreserveMetadata' },
          );
          if (!replaced) {
            throw Object.assign(
              new Error('Graph-scoped VM finalization requires atomic TripleStore.update() support'),
              { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' },
            );
          }
        }
        return 'preserved-metadata' as const;
      }

      const effectiveVersion = incomingVersionIsStale
        ? currentMaterializedVersion
        : materializedVersion;
      let metadataConfirmation: Parameters<typeof generateGraphKnowledgeAssetMetadata>[1];
      if (confirmation.kind === 'transaction') {
        let blockTimestamp = Math.floor(Date.now() / 1000);
        if (this.chain && typeof (this.chain as any).getBlockTimestamp === 'function') {
          try {
            blockTimestamp = await (this.chain as any).getBlockTimestamp(confirmation.blockNumber);
          } catch {
            this.log.info(
              ctx,
              `Could not fetch block timestamp for block ${confirmation.blockNumber}, using local time`,
            );
          }
        }
        const provenance: OnChainProvenance = {
          txHash: confirmation.txHash,
          blockNumber: confirmation.blockNumber,
          blockTimestamp,
          publisherAddress: confirmation.publisherAddress,
          batchId,
          chainId: this.chain?.chainId ?? 'unknown',
        };
        metadataConfirmation = {
          status: 'confirmed',
          confirmation: { kind: 'transaction', provenance },
        };
      } else {
        metadataConfirmation = {
          status: 'confirmed',
          confirmation: {
            kind: 'finalized-materialization',
            provenance: { batchId, materializedVersion: effectiveVersion },
          },
        };
      }
      const metadata = generateGraphKnowledgeAssetMetadata(
        {
          ual: scope.ual,
          contextGraphId,
          merkleRoot: computedMerkleRoot,
          publisherPeerId: head.publisherPeerId,
          accessPolicy: metadataAccessPolicy,
          ...(metadataAccessPolicy === 'allowList'
            ? { allowedPeers: [...metadataAllowedPeers] }
            : {}),
          timestamp: new Date(),
          subGraphName,
          ...(authorAddress ? { authorAddress } : {}),
          assertionVersion: scope.assertionVersion,
          publicTripleCount,
          ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
          privateTripleCount,
          assertionGraph: vmGraph,
        },
        metadataConfirmation,
      );
      const committedMetadata = confirmation.kind === 'transaction'
        ? [...metadata, materializedVersionQuad(metaGraph, scope.ual, effectiveVersion)]
        : metadata;
      const vmQuads = verifiedQuads.map((quad) => ({ ...quad, graph: vmGraph }));
      const replaced = await tryReplaceGraphAndSubjectAtomically(
        this.store,
        vmGraph,
        vmQuads,
        metaGraph,
        scope.ual,
        committedMetadata,
        { source: 'agent.finalization.graphScopedAtomicCommit' },
      );
      if (!replaced) {
        throw Object.assign(
          new Error('Graph-scoped VM finalization requires atomic graph-and-metadata replacement support'),
          { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' },
        );
      }
      return 'applied' as const;
    });
    if (outcome !== 'applied') return outcome;

    this.eventBus?.emit(DKGEvent.MEMORY_GRAPH_CHANGED, {
      contextGraphId,
      layers: ['vm'],
      subGraphName,
      operation: 'verifiable_memory_finalized',
      source,
      counts: { roots: 0, triples: publicTripleCount },
    });
    return 'applied';
  }

  /**
   * Return the single confirmed assertion version already bound to an exact
   * chain root. This is the ambiguity guard for policy-only/same-content heads.
   */
  private async confirmedGraphScopedAssertionVersionForRoot(input: {
    contextGraphId: string;
    ual: string;
    merkleRoot: Uint8Array;
  }): Promise<string | undefined> {
    let metaGraph: string;
    let safeUal: string;
    try {
      metaGraph = assertSafeIri(contextGraphMetaUri(input.contextGraphId));
      safeUal = assertSafeIri(input.ual);
    } catch {
      return undefined;
    }
    const result = await this.store.query(
      `SELECT ?version ?root ?scope WHERE {
        GRAPH <${metaGraph}> {
          <${safeUal}> <${DKG_NS}status> "confirmed" ;
            <${DKG_NS}assertionVersion> ?version ;
            <${DKG_NS}merkleRoot> ?root ;
            <${DKG_NS}contentScopeVersion> ?scope .
        }
      }`,
      { source: 'agent.finalization.confirmedAssertionVersion' },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    const expectedRoot = normalizedHex(ethers.hexlify(input.merkleRoot));
    const versions = new Set<string>();
    for (const binding of result.bindings) {
      const version = stripOptionalLiteral(binding['version']);
      const root = stripOptionalLiteral(binding['root']);
      const scopeVersion = stripOptionalLiteral(binding['scope']);
      if (
        version === undefined
        || root === undefined
        || Number(scopeVersion) !== GRAPH_KA_CONTENT_SCOPE_VERSION
        || normalizedHex(root) !== expectedRoot
      ) {
        return undefined;
      }
      versions.add(version);
    }
    return versions.size === 1 ? versions.values().next().value : undefined;
  }

  private markProcessed(dedupeKey: string): void {
    this.processedUals.add(dedupeKey);
    if (this.processedUals.size > 10_000) {
      const first = this.processedUals.values().next().value;
      if (first) this.processedUals.delete(first);
    }
  }

  /** Verify the complete metadata envelope after exact VM content is proven. */
  private async graphScopedMetadataState(input: {
    contextGraphId: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    head: GraphScopedMaterializationEnvelope;
    merkleRoot: Uint8Array;
    batchId: bigint;
    expectedTxHash?: string;
    materializedVersion?: MaterializedVersion;
    access: GraphScopedAccessEnvelope;
    confirmationKind?: 'transaction' | 'finalized-materialization';
    authorAddress?: string;
    subGraphName?: string;
  }): Promise<'matching' | 'different' | 'absent'> {
    const {
      contextGraphId,
      scope,
      head,
      merkleRoot,
      batchId,
      expectedTxHash,
      materializedVersion,
      access,
      confirmationKind = 'transaction',
      authorAddress,
      subGraphName,
    } = input;
    let metaGraph: string;
    let safeUal: string;
    try {
      metaGraph = assertSafeIri(contextGraphMetaUri(contextGraphId));
      safeUal = assertSafeIri(scope.ual);
    } catch {
      return 'absent';
    }
    const result = await this.store.query(
      `SELECT ?predicate ?object WHERE {
        GRAPH <${metaGraph}> { <${safeUal}> ?predicate ?object }
      }`,
      { source: 'agent.finalization.graphScopedMetadataState' },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return 'absent';

    const objects = new Map<string, string[]>();
    for (const binding of result.bindings) {
      const predicate = binding['predicate'];
      const object = binding['object'];
      if (!predicate || object === undefined) continue;
      const values = objects.get(predicate) ?? [];
      values.push(object);
      objects.set(predicate, values);
    }
    const rawValues = (predicate: string): string[] => objects.get(predicate) ?? [];
    const oneRaw = (predicate: string): string | undefined => {
      const values = rawValues(predicate);
      return values.length === 1 ? values[0] : undefined;
    };
    const oneLiteral = (predicate: string): string | undefined =>
      stripOptionalLiteral(oneRaw(predicate));
    const scopeValues = rawValues(`${DKG_NS}contentScopeVersion`);
    if (scopeValues.length === 0) return 'absent';

    try {
      const expectedGraph = knowledgeAssetLayerGraphUri(
        contextGraphId,
        MemoryLayer.VerifiableMemory,
        scope,
        subGraphName,
      );
      const rawPrivateRoots = rawValues(`${DKG_NS}privateMerkleRoot`);
      const rawPrivateMerkleRoot = rawPrivateRoots.length === 1
        ? stripOptionalLiteral(rawPrivateRoots[0])
        : undefined;
      const expectedPrivateMerkleRoot = head.privateMerkleRoot
        ? normalizedHex(head.privateMerkleRoot)
        : undefined;
      const storedAllowedPeerValues = rawValues(`${DKG_NS}allowedPeer`);
      const storedAllowedPeers = storedAllowedPeerValues
        .map((value) => stripOptionalLiteral(value))
        .filter((value): value is string => value !== undefined);
      const expectedAllowedPeers = access.accessPolicy === 'allowList'
        ? [...new Set(access.allowedPeers)].sort()
        : [];
      const actualAllowedPeers = [...new Set(storedAllowedPeers)].sort();
      const storedMaterializedVersion = oneLiteral(`${DKG_NS}materializedVersion`);
      const storedTransactionHash = oneLiteral(`${DKG_NS}transactionHash`);
      const storedConfirmationKind = oneLiteral(`${DKG_NS}confirmationKind`) ?? 'transaction';
      const parsedMaterializedVersion = /^(\d+):(\d+)$/.exec(storedMaterializedVersion ?? '');
      const expectedMaterializedVersion = materializedVersion
        ? `${materializedVersion.blockNumber}:${materializedVersion.txIndex}`
        : undefined;
      const attributionValues = rawValues(`${PROV_NS}wasAttributedTo`);
      const expectedAttribution = authorAddress
        && !/^0x0{40}$/i.test(authorAddress)
        ? `did:dkg:agent:${ethers.getAddress(authorAddress).toLowerCase()}`
        : undefined;
      if (
        Number(oneLiteral(`${DKG_NS}contentScopeVersion`)) !== GRAPH_KA_CONTENT_SCOPE_VERSION
        || oneRaw(`${DKG_NS}kaUal`) !== scope.ual
        || oneLiteral(`${DKG_NS}assertionVersion`) !== scope.assertionVersion
        || oneRaw(`${DKG_NS}assertionGraph`) !== expectedGraph
        || Number(oneLiteral(`${DKG_NS}publicTripleCount`)) !== head.publicTripleCount
        || Number(oneLiteral(`${DKG_NS}privateTripleCount`)) !== head.privateTripleCount
        || rawPrivateRoots.length !== (expectedPrivateMerkleRoot ? 1 : 0)
        || (rawPrivateMerkleRoot ? normalizedHex(rawPrivateMerkleRoot) : undefined)
          !== expectedPrivateMerkleRoot
        || normalizedHex(oneLiteral(`${DKG_NS}merkleRoot`) ?? '')
          !== normalizedHex(ethers.hexlify(merkleRoot))
        || oneLiteral(`${DKG_NS}status`) !== 'confirmed'
        || BigInt(oneLiteral(`${DKG_NS}batchId`) ?? '-1') !== batchId
        || storedConfirmationKind !== confirmationKind
        || (confirmationKind === 'transaction'
          ? storedTransactionHash === undefined
            || (expectedTxHash !== undefined
              && normalizedHex(storedTransactionHash) !== normalizedHex(expectedTxHash))
          : storedTransactionHash !== undefined)
        || !parsedMaterializedVersion
        || !Number.isSafeInteger(Number(parsedMaterializedVersion[1]))
        || !Number.isSafeInteger(Number(parsedMaterializedVersion[2]))
        || (expectedMaterializedVersion !== undefined
          && storedMaterializedVersion !== expectedMaterializedVersion)
        || oneLiteral(`${DKG_NS}accessPolicy`) !== access.accessPolicy
        || oneLiteral(`${DKG_NS}publisherPeerId`) !== head.publisherPeerId
        || oneRaw(`${DKG_NS}contextGraph`) !== `did:dkg:context-graph:${contextGraphId}`
        || !oneLiteral(`${DKG_NS}publishedAt`)
        || (subGraphName
          ? oneLiteral(`${DKG_NS}subGraphName`) !== subGraphName
          : rawValues(`${DKG_NS}subGraphName`).length !== 0)
        || storedAllowedPeerValues.length !== expectedAllowedPeers.length
        || actualAllowedPeers.length !== expectedAllowedPeers.length
        || actualAllowedPeers.some((peer, index) => peer !== expectedAllowedPeers[index])
        || attributionValues.length !== 1
        || (expectedAttribution !== undefined && attributionValues[0] !== expectedAttribution)
      ) {
        return 'different';
      }
      return 'matching';
    } catch {
      return 'different';
    }
  }

  /** Advance only the O(1) ordering stamp after exact VM and metadata verification. */
  private async advanceExactGraphScopedVersion(input: {
    contextGraphId: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    materializedVersion: MaterializedVersion;
  }): Promise<void> {
    const metaGraph = contextGraphMetaUri(input.contextGraphId);
    await withMaterializationLock(metaGraph, input.scope.ual, async () => {
      const current = await readMaterializedVersion(
        this.store,
        metaGraph,
        input.scope.ual,
      );
      if (
        !current
        || compareMaterializedVersion(input.materializedVersion, current) > 0
      ) {
        await writeMaterializedVersion(
          this.store,
          metaGraph,
          input.scope.ual,
          input.materializedVersion,
        );
      }
    });
  }

  private async hasGraphScopedMetadata(contextGraphId: string, ual: string): Promise<boolean> {
    try {
      const metaGraph = assertSafeIri(contextGraphMetaUri(contextGraphId));
      const safeUal = assertSafeIri(ual);
      const result = await this.store.query(
        `ASK { GRAPH <${metaGraph}> {
          { <${safeUal}> <${DKG_NS}contentScopeVersion> ?value }
          UNION { <${safeUal}> <${DKG_NS}kaUal> ?value }
          UNION { <${safeUal}> <${DKG_NS}assertionGraph> ?value }
        } }`,
        { source: 'agent.finalization.hasGraphScopedMetadata' },
      );
      return result.type === 'boolean' && result.value;
    } catch {
      return false;
    }
  }

  /**
   * Read-both (adversarial review F5, RFC ka-metadata-trim): the REQUIRED
   * `dkg:status "confirmed"` ASK used to target only the per-cgId partition
   * meta graph — but the minimal partition shape (`restateKaPartition`, the
   * publisher's own same-graph promote) no longer carries `dkg:status`; the
   * status row lives in the LABEL `_meta` graph. Without the fallback the
   * gossip/chain-reconcile dedup never fired on new-shape stores and the
   * publisher's own broadcast echo re-promoted. Old-shape stores (and the
   * replica full-move path, which still writes status into the partition)
   * keep their original semantics via the first GRAPH clause; `labelMetaGraph`
   * is only consulted as the UNION branch.
   */
  private async isAlreadyConfirmed(ual: string, metaGraph: string, labelMetaGraph?: string): Promise<boolean> {
    try {
      const safeUal = assertSafeIri(ual);
      const partitionPattern = `GRAPH <${assertSafeIri(metaGraph)}> { <${safeUal}> <http://dkg.io/ontology/status> "confirmed" }`;
      const ask = labelMetaGraph && labelMetaGraph !== metaGraph
        ? `ASK { { ${partitionPattern} } UNION { GRAPH <${assertSafeIri(labelMetaGraph)}> { <${safeUal}> <http://dkg.io/ontology/status> "confirmed" } } }`
        : `ASK { ${partitionPattern} }`;
      const result = await this.store.query(ask, {
        source: 'agent.finalization.alreadyConfirmed',
      });
      return result.type === 'boolean' && result.value === true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the exact graph namespace from canonical graph-scoped metadata.
   * A named assertion stores its namespace in the root metadata graph, so this
   * stays exact and does not enumerate workspace operations or subgraphs.
   */
  private async resolveExactChainReconcileInput<
    T extends Pick<ChainReconciledKCInput, 'contextGraphId' | 'ual' | 'subGraphName'>,
  >(
    input: T,
    ctx: OperationContext,
  ): Promise<T | null> {
    if (input.subGraphName !== undefined) return input;
    try {
      const rootMetaGraph = contextGraphMetaUri(input.contextGraphId);
      const lifecycleRows = await this.store.query(
        `SELECT ?lifecycle ?subGraphName WHERE { GRAPH <${assertSafeIri(rootMetaGraph)}> {
          ?lifecycle <${DKG_NS}reservedUal> ${sparqlString(input.ual)} .
          OPTIONAL { ?lifecycle <${DKG_NS}subGraphName> ?subGraphName }
        } }`,
        { source: 'agent.finalization.resolveExactLifecycleNamespace' },
      );
      if (lifecycleRows.type !== 'bindings') {
        this.log.warn(ctx, `Chain-reconcile: lifecycle metadata query for ${input.ual} returned no bindings`);
        return null;
      }
      if (lifecycleRows.bindings.length > 0) {
        const lifecycleSubjects = new Set(
          lifecycleRows.bindings
            .map((binding) => stripOptionalLiteral(binding['lifecycle'])?.trim())
            .filter((value): value is string => Boolean(value)),
        );
        const subGraphNames = new Set(
          lifecycleRows.bindings
            .map((binding) => stripOptionalLiteral(binding['subGraphName'])?.trim())
            .filter((value): value is string => Boolean(value)),
        );
        if (lifecycleSubjects.size !== 1 || subGraphNames.size > 1) {
          this.log.warn(ctx, `Chain-reconcile: lifecycle metadata for ${input.ual} is ambiguous`);
          return null;
        }
        const [subGraphName] = subGraphNames;
        if (subGraphName !== undefined) {
          const validation = validateSubGraphName(subGraphName);
          if (!validation.valid) {
            this.log.warn(
              ctx,
              `Chain-reconcile: lifecycle metadata for ${input.ual} has an invalid sub-graph name`,
            );
            return null;
          }
          return { ...input, subGraphName };
        }
        return input;
      }

      const resolved = await resolveGraphScopedOrLegacyMetadata(
        this.store,
        input.ual,
        async () => null,
        { source: 'agent.finalization.resolveExactNamespace' },
      );
      if (resolved.kind !== 'graph') return input;
      if (resolved.metadata.contextGraphId !== input.contextGraphId) {
        this.log.warn(
          ctx,
          `Chain-reconcile: graph-scoped metadata for ${input.ual} belongs to a different Context Graph`,
        );
        return null;
      }
      return resolved.metadata.subGraphName === undefined
        ? input
        : { ...input, subGraphName: resolved.metadata.subGraphName };
    } catch (error) {
      this.log.warn(
        ctx,
        `Chain-reconcile: exact metadata for ${input.ual} is invalid: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Constant-time exact graph-scoped reconciliation. */
  private async reconcileExactChainRegisteredKC(
    rawInput: ChainReconciledKCInput,
    ctx: OperationContext,
  ): Promise<ExactChainReconcileDecision> {
    const resolvedInput = await this.resolveExactChainReconcileInput(rawInput, ctx);
    if (!resolvedInput) {
      return { outcome: 'no-swm', legacyMarkerEligible: false, input: rawInput };
    }
    const input = resolvedInput;
    const {
      contextGraphId, onChainCgId, ual, merkleRoot, publisherAddress,
      kaId, batchId, versionBlock, authorAddress, subGraphName,
      trustedAssertionEvidence, assertionVersion, versionSnapshot, signal,
    } = input;

    if (!(await this.verifyChainCgBinding(kaId, onChainCgId, ctx))) {
      this.log.info(
        ctx,
        `Chain-reconcile: chain CG binding for ${ual} (ka=${kaId}) not confirmed against cg ${onChainCgId}; deferring to sweep retry`,
      );
      return { outcome: 'unverified', legacyMarkerEligible: false, input };
    }

    const journalReplay = await this.replayMatchingRecoveryEntries(input, ctx);
    // The recovery index predates exact chain-rootCount evidence. Exact asset
    // inspection must therefore verify the resulting local assertion version
    // below instead of treating a same-root replay as sufficient on its own.
    if (journalReplay === 'recovered' && assertionVersion === undefined) {
      return { outcome: 'already-confirmed', legacyMarkerEligible: false, input };
    }
    if (journalReplay === 'retry-pending' && assertionVersion === undefined) {
      return { outcome: 'receipt-revalidation-pending', legacyMarkerEligible: false, input };
    }
    if (journalReplay === 'invalidated') {
      this.log.info(
        ctx,
        `Chain-reconcile: stale finalization evidence for ${ual} was invalidated; `
          + 'continuing current-target reconciliation',
      );
    }

    const graphScopedOutcome = await this.reconcileGraphScopedKC({
      contextGraphId,
      onChainCgId,
      ual,
      assertionVersion,
      merkleRoot,
      publisherAddress,
      kaId,
      batchId,
      versionBlock,
      authorAddress,
      versionSnapshot,
      signal,
      subGraphName,
      trustedAssertionEvidence,
    }, ctx);
    if (graphScopedOutcome !== undefined) {
      return { outcome: graphScopedOutcome, legacyMarkerEligible: false, input };
    }
    if (await this.hasGraphScopedMetadata(contextGraphId, ual)) {
      this.log.info(
        ctx,
        `Chain-reconcile: graph-scoped metadata exists for ${ual} but its durable workspace head is missing`,
      );
      return { outcome: 'no-swm', legacyMarkerEligible: false, input };
    }
    this.log.info(ctx, `Chain-reconcile: no local graph-scoped state for ${ual}`);
    return { outcome: 'no-swm', legacyMarkerEligible: true, input };
  }

  /**
   * Reconcile only the exact graph-scoped state named by one UAL. This is the
   * operation used by exact RFC64 fetch.
   */
  async handleExactChainReconciledKC(
    input: ChainReconciledKCInput,
    ctx: OperationContext,
  ): Promise<ChainReconciledKCOutcome> {
    return (await this.reconcileExactChainRegisteredKC(input, ctx)).outcome;
  }

  /**
   * Normal chain reconciliation: the exact operation, then the historical
   * confirmed marker of a KA materialized before per-KA graphs. A KA with no
   * local graph-scoped state answers `no-swm` and the caller fetches it from
   * peers; historical workspace operations are never searched for it.
   */
  async handleChainReconciledKC(
    rawInput: ChainReconciledKCInput,
    ctx: OperationContext,
  ): Promise<ChainReconciledKCOutcome> {
    const exact = await this.reconcileExactChainRegisteredKC(rawInput, ctx);
    if (!exact.legacyMarkerEligible) return exact.outcome;
    const { contextGraphId, onChainCgId, ual } = exact.input;
    const rootMetaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
    const targetMetaGraph = onChainCgId.length > 0
      ? contextGraphMetaUri(contextGraphId, onChainCgId)
      : rootMetaGraph;

    // The ordinary compatibility path may retain the historical confirmed
    // marker shortcut. Exact RFC-64 fetch cannot use this marker because it
    // proves neither the current assertion version nor the current chain root.
    if (await this.isAlreadyConfirmed(ual, targetMetaGraph, rootMetaGraph)) {
      this.log.info(ctx, `Chain-reconcile: legacy ${ual} already confirmed in VM, skipping`);
      return 'already-confirmed';
    }
    return exact.outcome;
  }

  /**
   * Decide from local state alone whether an ordinary chain reconcile of one
   * KA (no trusted evidence, no pinned assertion version) can depend on the
   * chain root. This walks {@link handleChainReconciledKC} in the same order
   * with the same helpers, and answers `present` wherever that path would need
   * the root or the publisher, or meets a rare state it handles on its own
   * (steps 1 and 4 keep their chain-backed diagnostics):
   *
   *  1. exact namespace resolution (the same resolver); ambiguous metadata;
   *  2. recovery-inbox entries for the KA, whose replay reads chain state;
   *  3. graph-scoped state: a workspace head, corrupt or not, is verified
   *     against the root. Without a head, a confirmed envelope whose stored
   *     content still verifies against its own recorded root is
   *     `confirmed-vm`, unless an orphaned SWM twin is left to retire;
   *  4. graph-scoped metadata without a head or confirmed copy;
   *  5. the legacy confirmed marker, which that path answers
   *     `already-confirmed` without reading the root;
   *  6. nothing else is searched, so everything left is `none`.
   *
   * `confirmed-vm` trusts the root the local copy was confirmed at; a newer
   * on-chain version is not looked for here, which keeps the walk free of
   * chain reads for copies it already holds. The walk never revisits a settled
   * ordinal either, so an update reaches a held copy through finalization
   * gossip, the StorageACK pending-update lane, the chain-backed path this
   * method routes a local SWM head to (`present`) while its ordinal is still
   * walked, and, for any confirmed copy, the `KnowledgeAssetUpdated` refresh
   * (`handleKAUpdatedNudge` in the agent's SWM host).
   *
   * Any read failure answers `present`, keeping the caller on its chain path.
   */
  async classifyChainReconcileLocalCandidate(
    input: ChainReconcileLocalCandidateInput,
    ctx: OperationContext,
  ): Promise<ChainReconcileLocalCandidate> {
    try {
      return await this.classifyChainReconcileLocalCandidateOrThrow(input, ctx);
    } catch {
      return LOCAL_CANDIDATE_PRESENT;
    }
  }

  private async classifyChainReconcileLocalCandidateOrThrow(
    rawInput: ChainReconcileLocalCandidateInput,
    ctx: OperationContext,
  ): Promise<ChainReconcileLocalCandidate> {
    const input = await this.resolveExactChainReconcileInput(rawInput, ctx);
    if (!input) return LOCAL_CANDIDATE_PRESENT;
    const { contextGraphId, onChainCgId, ual, kaId, batchId, subGraphName } = input;
    if (await this.recovery.mayReplayForKnowledgeAsset({
      chainId: this.chain?.chainId ?? 'none',
      contextGraphId,
      ual,
      kaId: kaId.toString(),
    })) {
      return LOCAL_CANDIDATE_PRESENT;
    }

    let graphScopedUal = true;
    try {
      createGraphKnowledgeAssetScope(ual, 1);
    } catch {
      graphScopedUal = false;
    }
    if (graphScopedUal) {
      // A corrupt head throws here and answers `present`: the chain-backed
      // path owns its containment.
      const head = await resolveKnowledgeAssetWorkspaceHead({
        store: this.store,
        graphManager: new GraphManager(this.store),
        contextGraphId,
        kaUal: ual,
        subGraphName,
      });
      if (head) return LOCAL_CANDIDATE_PRESENT;
      const confirmed = await resolveLocallyConfirmedGraphScopedVm(this.store, {
        contextGraphId,
        ual,
        kaId,
        batchId,
        ...(subGraphName ? { subGraphName } : {}),
      });
      if (confirmed.status === 'invalid') return LOCAL_CANDIDATE_PRESENT;
      if (confirmed.status === 'verified') {
        return await this.hasOrphanedGraphScopedSwmTwin(contextGraphId, confirmed.scope, subGraphName)
          ? LOCAL_CANDIDATE_PRESENT
          : { kind: 'confirmed-vm', layout: 'graph-scoped' };
      }
    }
    if (await this.hasGraphScopedMetadata(contextGraphId, ual)) return LOCAL_CANDIDATE_PRESENT;

    const rootMetaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
    const targetMetaGraph = onChainCgId.length > 0
      ? contextGraphMetaUri(contextGraphId, onChainCgId)
      : rootMetaGraph;
    if (await this.isAlreadyConfirmed(ual, targetMetaGraph, rootMetaGraph)) {
      return { kind: 'confirmed-vm', layout: 'legacy' };
    }
    return { kind: 'none' };
  }

  /**
   * Whether the headless-VM retirement in the chain-backed path would find an
   * SWM twin: the per-KA shared-memory graphs it drops, in its namespace.
   */
  private async hasOrphanedGraphScopedSwmTwin(
    contextGraphId: string,
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>,
    subGraphName: string | undefined,
  ): Promise<boolean> {
    // Without the retirement hook the chain-backed path retires nothing either.
    if (this.retireConfirmedGraphScopedSwmTwinIfOrphaned === undefined) return false;
    const graphs = await resolveSharedMemoryScopeGraphs(
      this.store,
      new GraphManager(this.store).sharedMemoryUri(contextGraphId, subGraphName),
      {
        kind: 'named-lifecycle',
        identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) },
      },
    );
    const result = await this.store.query(
      `ASK { ${graphs.map((graph) => `{ GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o } }`).join(' UNION ')} }`,
      { source: 'agent.finalization.localCandidate.swmTwin' },
    );
    return result.type !== 'boolean' || result.value;
  }

  private async verifyChainCgBinding(kaId: bigint, onChainCgId: string, ctx: OperationContext): Promise<boolean> {
    if (!this.chain || this.chain.chainId === 'none' || typeof this.chain.getKAContextGraphId !== 'function') {
      return false;
    }
    try {
      const boundCg = await this.chain.getKAContextGraphId(kaId);
      return boundCg.toString() === onChainCgId;
    } catch (err) {
      this.log.info(ctx, `Chain-reconcile: getKAContextGraphId(${kaId}) failed (RPC lag?): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

}
