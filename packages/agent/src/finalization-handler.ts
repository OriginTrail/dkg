import {
  decodeFinalizationMessage,
  contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  contextGraphDataUri, contextGraphMetaUri,
  contextGraphSubGraphUri, validateSubGraphName, validateContextGraphId,
  DKGEvent, Logger, createOperationContext,
  assertSafeIri, isSafeIri,
  type EventBus,
  type FinalizationMessageMsg,
  type OperationContext,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  ENTITY_PRED_ALT,
  getMetrics,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  loadSelectedSharedMemoryQuads,
  loadSharedMemorySliceWithKaBoundFallback,
  asGraphWriteGenSource,
  tryReplaceGraphAtomically,
  tryReplaceGraphAndSubjectAtomically,
  StoreSchedulerBusyError,
  type GraphWriteGenSource,
  type SharedMemoryResultBudget,
  type SwmKaGraphBound,
  type TripleStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { type ChainAdapter, type EventFilter } from '@origintrail-official/dkg-chain';
import {
  computeFlatKCRootV10 as computeFlatKCRoot, skolemizeByEntity,
  generatedPrivateCatalogFloorQuads,
  generatedPrivateCatalogTripleKeys,
  generateConfirmedFullMetadata, generateGraphKnowledgeAssetMetadata,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  buildDeterministicTokenRows, compareRootIris, getTentativeStatusQuad,
  insertBoundedAgentRegistryMeta,
  generateSubGraphRegistration,
  splitTrustedGeneratedCatalogRootMap,
  compareMaterializedVersion, readMaterializedVersion,
  shouldApplyMaterialization, writeMaterializedVersion, materializedVersionQuad,
  withMaterializationLock,
  KnowledgeAssetWorkspaceHeadCorruptError,
  resolveKnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest,
  type MaterializedVersion,
  type KnowledgeAssetWorkspaceHead,
  type KCMetadata, type KAMetadata, type OnChainProvenance,
} from '@origintrail-official/dkg-publisher';
const DKG_NS = 'http://dkg.io/ontology/';
const PROV_NS = 'http://www.w3.org/ns/prov#';

// Slow-query / canary tags for the finalization SWM slice (#1549). A healthy fleet
// sees `.fallbackUnbounded` at ~0 relative to `.bounded`; a spike means the bound is
// mis-derived or recurrence is common, and `DKG_DISABLE_SWM_KA_BOUND=1` is the lever.
const SWM_SLICE_SOURCE = 'agent.finalization.sharedMemorySlice';
const SWM_SLICE_SOURCE_BOUNDED = `${SWM_SLICE_SOURCE}.bounded`;
const SWM_SLICE_SOURCE_WIDENED = `${SWM_SLICE_SOURCE}.fallbackUnbounded`;
import { ethers } from 'ethers';
import { createHash } from 'node:crypto';
import { deriveSwmKaGraphBound } from './swm-ka-bound.js';
import {
  FinalizationLifecycleLogger,
  finalizationLifecycleDecision,
  type FinalizationLifecycleLogOptions,
} from './finalization-lifecycle-logger.js';
import {
  FinalizationRecoveryJournal,
} from './finalization-recovery-journal.js';
import {
  FinalizationRecovery,
  parseGraphScopedFinalization,
  type FinalizationRecoveryApplyOutcome,
  type GraphScopedFinalizationAdmission,
  type GraphScopedAccessPolicy,
  type ParsedGraphScopedFinalization,
} from './finalization-recovery.js';

/**
 * Predicate for the durable per-root keep-root-copy signal the publisher
 * persists into SWM workspace meta at publish time (the chain-driven
 * reconcile path's equivalent of the gossip envelope's `keepRootCopyOnLabel`).
 * Shared with `DKGAgent` so the write and read sites can't drift.
 */
export const KEEP_ROOT_COPY_PREDICATE = `${DKG_NS}keepRootCopyOnLabel`;

/**
 * Reader-maintained memo (#1609): the flat-KC merkle root a WorkspaceOperation's
 * SWM snapshot hashes to, paired with `SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE` (a
 * cheap digest of the exact content that produced it), stamped onto the op subject
 * (`urn:dkg:share:<cg>:<id>`) the first time `findSwmSnapshotInNamespace` computes
 * it. Lets a chain-reconcile lookup (a) resolve a *present* KA's op by root
 * directly (fast path), and (b) skip the expensive `computeFlatKCRoot` recompute
 * for an op whose content is unchanged (the digest still matches) — the recompute
 * that dominates beacon reconcile load when a KA published elsewhere forces a full
 * O(#WorkspaceOperations) scan to conclude "not here".
 *
 * This memo is a bridge, NOT the durable fix (see OT-RFC-60): a WorkspaceOperation
 * is assembled incrementally (data quads and private roots arrive over time via
 * *entity-keyed* writes that do NOT rewrite the op subject), so the stamp can go
 * stale without a structural invalidation. Correctness therefore does NOT rely on
 * the stamp being fresh:
 *   - `verifyMerkleMatch` stays authoritative on the fast path — a stale stamp can
 *     only ever cause a *missed* promotion, never a wrong one.
 *   - the fallback scan re-reads EVERY op (it never excludes on stamp-presence) and
 *     trusts the memoized root only when the content digest still matches; any
 *     content change flips the digest → full recompute → the op is re-evaluated and
 *     re-stamped. An op can never be stranded by a stale stamp.
 * The durable fix (OT-RFC-60) makes the root a write-maintained, indexed property
 * stamped once when an op becomes complete-and-immutable, removing both the
 * recompute AND the staleness by construction.
 *
 * Deliberately invisible to the sibling VM-reconcile negative cache: its
 * `readVmReconcileSwmGen` / `vmReconcileWorkspaceOperationPattern` fingerprints
 * select only `rootEntity`/`publishedAt` on the op subject (plus the separate data
 * graph), so stamping these predicates into the meta graph does not perturb the
 * generation signal the negative cache keys on — the two mechanisms don't fight.
 */
export const SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE = `${DKG_NS}snapshotMerkleRoot`;
export const SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE = `${DKG_NS}snapshotContentDigest`;

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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

type ExactGraphScopedLayerVerification =
  | {
      status: 'verified';
      graphUri: string;
      quads: Quad[];
      merkleRoot: Uint8Array;
    }
  | {
      status: 'count-mismatch';
      graphUri: string;
      actualCount: number;
    }
  | {
      status: 'merkle-mismatch';
      graphUri: string;
    }
  | {
      status: 'head-mismatch';
      graphUri: string;
    };

type GraphScopedMaterializationEnvelope = Pick<
  KnowledgeAssetWorkspaceHead,
  | 'publicTripleCount'
  | 'privateMerkleRoot'
  | 'privateTripleCount'
  | 'publisherPeerId'
  | 'accessPolicy'
  | 'allowedPeers'
>;

/** Immutable queued assertion envelope supplied only after receipt/seal validation. */
interface TrustedGraphScopedAssertionEvidence extends GraphScopedMaterializationEnvelope {
  assertionVersion: string;
  publicQuadsDigest?: string;
  transactionHash: string;
  accessPolicy: GraphScopedAccessPolicy;
  allowedPeers: string[];
}

function resolveGraphScopedAccessEnvelope(
  head: GraphScopedMaterializationEnvelope,
  requestedAccessPolicy?: GraphScopedAccessPolicy,
  requestedAllowedPeers: string[] = [],
): { accessPolicy: GraphScopedAccessPolicy; allowedPeers: string[] } {
  const accessPolicy = requestedAccessPolicy
    ?? head.accessPolicy
    ?? 'ownerOnly';
  const allowedPeers = accessPolicy === 'allowList'
    ? (requestedAccessPolicy ? requestedAllowedPeers : head.allowedPeers)
    : [];
  if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
    return { accessPolicy: 'ownerOnly', allowedPeers: [] };
  }
  return { accessPolicy, allowedPeers };
}

function normalizedHex(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}

/**
 * Ops kill-switch for the #1549 bounded SWM read. Set `DKG_DISABLE_SWM_KA_BOUND=1`
 * to fall back to the unbounded read with no redeploy. Read here at the
 * orchestration boundary so `deriveSwmKaGraphBound` (in `swm-ka-bound.ts`) stays a
 * deterministic identity transform.
 */
function swmKaBoundDisabled(): boolean {
  return process.env.DKG_DISABLE_SWM_KA_BOUND === '1';
}

/**
 * TTL cap on the in-memory negative reconcile memo (#1609) — the longest a
 * "no local SWM snapshot" verdict may be trusted without a fresh scan even
 * when no write-generation change was observed. Bounds the exposure to any
 * SWM writer invisible to the adapter's write-generation counter (e.g. a
 * second process mutating a shared oxigraph-server) to "≤ TTL late", never
 * "never". Read per call (like `swmKaBoundDisabled`) so ops and tests can
 * retune it without a redeploy.
 */
const VM_RECONCILE_NEGATIVE_TTL_MS_DEFAULT = 600_000;
function vmReconcileNegativeTtlMs(): number {
  const raw = Number(process.env['DKG_VM_RECONCILE_NEGATIVE_TTL_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : VM_RECONCILE_NEGATIVE_TTL_MS_DEFAULT;
}

/** LRU cap for the negative reconcile memo — bounds memory across CGs × roots. */
const VM_RECONCILE_NEGATIVE_MEMO_MAX_ENTRIES = 4096;

const FINALIZATION_SWM_PAGE_ROWS_DEFAULT = 1_000;
const FINALIZATION_SWM_MAX_ROWS_DEFAULT = 250_000;
const FINALIZATION_SWM_MAX_BYTES_DEFAULT = 128 * 1024 * 1024;

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finalizationSwmResultBudget(): SharedMemoryResultBudget {
  return {
    pageRows: positiveIntegerEnv('DKG_FINALIZATION_SWM_PAGE_ROWS', FINALIZATION_SWM_PAGE_ROWS_DEFAULT),
    maxRows: positiveIntegerEnv('DKG_FINALIZATION_SWM_MAX_ROWS', FINALIZATION_SWM_MAX_ROWS_DEFAULT),
    maxBytesEstimate: positiveIntegerEnv(
      'DKG_FINALIZATION_SWM_MAX_BYTES',
      FINALIZATION_SWM_MAX_BYTES_DEFAULT,
    ),
  };
}

type NegativeSnapshotMemoEntry = {
  /** Write generation for the CG's graph prefix observed BEFORE the scan. */
  writeGen: number;
  recordedAt: number;
  /** Catalog-floor eligibility at scan time — a policy flip changes what can match. */
  allowGeneratedCatalogFloor: boolean;
};

export interface FinalizationHandlerOptions {
  eventBus?: EventBus;
  resolveContextGraphOnChainId?: ResolveContextGraphOnChainId;
  markContextGraphMetaDirtyFromQuads?: MarkContextGraphMetaDirtyFromQuads;
  lifecycleLogOptions?: FinalizationLifecycleLogOptions;
  recoveryJournal?: FinalizationRecoveryJournal;
}

function normalizeFinalizationHandlerOptions(
  optionsOrEventBus: FinalizationHandlerOptions | EventBus | undefined,
  resolveContextGraphOnChainId: ResolveContextGraphOnChainId | undefined,
  markContextGraphMetaDirtyFromQuads: MarkContextGraphMetaDirtyFromQuads | undefined,
  lifecycleLogOptions: FinalizationLifecycleLogOptions | undefined,
  recoveryJournal: FinalizationRecoveryJournal | undefined,
): FinalizationHandlerOptions {
  const hasLegacyTail = resolveContextGraphOnChainId !== undefined
    || markContextGraphMetaDirtyFromQuads !== undefined
    || lifecycleLogOptions !== undefined
    || recoveryJournal !== undefined;
  const looksLikeEventBus = optionsOrEventBus !== undefined
    && typeof (optionsOrEventBus as EventBus).emit === 'function';
  if (hasLegacyTail || looksLikeEventBus) {
    return {
      ...(optionsOrEventBus ? { eventBus: optionsOrEventBus as EventBus } : {}),
      ...(resolveContextGraphOnChainId ? { resolveContextGraphOnChainId } : {}),
      ...(markContextGraphMetaDirtyFromQuads ? { markContextGraphMetaDirtyFromQuads } : {}),
      ...(lifecycleLogOptions ? { lifecycleLogOptions } : {}),
      ...(recoveryJournal ? { recoveryJournal } : {}),
    };
  }
  return (optionsOrEventBus as FinalizationHandlerOptions | undefined) ?? {};
}

interface DecodedFinalizationEnvelope {
  rawMessage: Uint8Array;
  msg: FinalizationMessageMsg;
  graphAdmission?: GraphScopedFinalizationAdmission;
}

class FinalizationHandlerCore {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly resolveContextGraphOnChainId: ResolveContextGraphOnChainId | undefined;
  private readonly markContextGraphMetaDirtyFromQuads: MarkContextGraphMetaDirtyFromQuads | undefined;
  private readonly recovery: FinalizationRecovery;
  private readonly log = new Logger('FinalizationHandler');
  private readonly lifecycle: FinalizationLifecycleLogger;
  private readonly processedUals = new Set<string>();
  // Forward-prevention for the cgId-resolution race (RS heal): chain-authoritative
  // kaId(batchId)->cgId bindings, cached POSITIVE-ONLY. A 0/miss is NEVER cached —
  // caching a miss for a KC finalized before its on-chain KA->CG binding lands
  // would pin it to the legacy `/_meta` fallback forever, re-opening the race.
  private readonly chainCgIdByBatchId = new Map<string, string>();
  // #1609 (2026-07-11/12 testnet incident): the write-generation source backing
  // the negative reconcile memo below. `null` when the store's adapter doesn't
  // track write generations — the memo is then DISABLED and every reconcile
  // scans (fail-open), matching pre-memo behavior.
  private readonly graphWriteGen: GraphWriteGenSource | null;
  // Negative memo for `findSwmSnapshotForMerkleRoot`: "this (cg, namespace,
  // root) had NO matching local SWM snapshot at write generation G". Unlike
  // `chainCgIdByBatchId` above, caching the negative here is sound BECAUSE it
  // is generation-gated: the verdict is only replayed while the store proves
  // no local write has touched the CG since the scan. LRU, in-memory only —
  // a restart clears it (fail-open).
  private readonly negativeSnapshotMemo = new Map<string, NegativeSnapshotMemoEntry>();
  /** Equivalent finalization/reconcile reads share one promise until it settles. */
  private readonly scanSingleFlights = new Map<string, Promise<unknown>>();

  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    options: FinalizationHandlerOptions = {},
  ) {
    this.store = store;
    this.graphWriteGen = asGraphWriteGenSource(store);
    this.chain = chain;
    this.eventBus = options.eventBus;
    this.resolveContextGraphOnChainId = options.resolveContextGraphOnChainId;
    this.markContextGraphMetaDirtyFromQuads = options.markContextGraphMetaDirtyFromQuads;
    this.lifecycle = new FinalizationLifecycleLogger(this.log, options.lifecycleLogOptions);
    this.recovery = new FinalizationRecovery(
      options.recoveryJournal,
      chain,
      (rawMessage, contextGraphId, sourcePeerId) => {
        const envelope = this.decodeFinalizationEnvelope(rawMessage, contextGraphId);
        return envelope
          ? this.processFinalizationEnvelope(envelope, contextGraphId, sourcePeerId)
          : Promise.resolve('deferred');
      },
      {
        info: (message) => this.log.info(createOperationContext('system'), message),
        warn: (message) => this.log.warn(createOperationContext('system'), message),
      },
    );
  }

  async handleFinalizationMessage(
    data: Uint8Array,
    contextGraphId: string,
    sourcePeerId?: string,
  ): Promise<void> {
    const envelope = this.decodeFinalizationEnvelope(data, contextGraphId);
    if (!envelope) return;
    const candidate = envelope.graphAdmission?.ok
      ? envelope.graphAdmission.value
      : undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const outcome = await this.processFinalizationEnvelope(
          envelope,
          contextGraphId,
          sourcePeerId,
        );
        if (candidate) await this.recovery.settle(candidate.msg, contextGraphId, outcome);
        return;
      } catch (error) {
        if (!(error instanceof StoreSchedulerBusyError)) throw error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        const journaled = candidate
          ? await this.recovery.recordRawOnBusy({
            rawMessage: data,
            contextGraphId,
            ...(sourcePeerId ? { sourcePeerId } : {}),
            candidate,
          })
          : false;
        this.log.warn(
          candidate?.msg.operationId
            ? createOperationContext('gossip', candidate.msg.operationId)
            : createOperationContext('gossip'),
          `Finalization: store remained busy after retry; `
            + `${journaled
              ? `journaled ${candidate!.scope.ual}`
              : 'no durable recovery envelope was written'}`,
        );
        if (!journaled) throw error;
        return;
      }
    }
  }

  private decodeFinalizationEnvelope(
    rawMessage: Uint8Array,
    contextGraphId: string,
  ): DecodedFinalizationEnvelope | undefined {
    try {
      const msg = decodeFinalizationMessage(rawMessage);
      return {
        rawMessage,
        msg,
        ...(msg.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
          ? { graphAdmission: parseGraphScopedFinalization(msg, contextGraphId) }
          : {}),
      };
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

  private async processFinalizationEnvelope(
    envelope: DecodedFinalizationEnvelope,
    contextGraphId: string,
    sourcePeerId?: string,
  ): Promise<FinalizationRecoveryApplyOutcome> {
    let ctx = createOperationContext('gossip');
    let resolvedTargetContextGraphId: string | undefined;
    const { rawMessage, msg, graphAdmission } = envelope;
    try {
      resolvedTargetContextGraphId = msg.targetContextGraphId || undefined;
      if (msg.operationId) {
        ctx = createOperationContext('gossip', msg.operationId);
      }

      const isGraphScoped = msg.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION;
      if (isGraphScoped && !graphAdmission?.ok) {
        this.log.warn(
          ctx,
          `Finalization: invalid graph-scoped envelope for ${msg.ual || '(missing UAL)'}: `
            + `${graphAdmission?.reason ?? 'decode-failed'}`,
        );
        return 'deferred';
      }

      if (msg.contextGraphId && msg.contextGraphId !== contextGraphId) {
        // #1100: same guard as GossipPublishHandler — frames of other gossip
        // message types decode "successfully" with garbage in this field, so
        // only WARN when the mismatched value is a plausible CG id.
        if (!validateContextGraphId(msg.contextGraphId).valid) return 'deferred';
        this.log.warn(ctx, `Finalization: contextGraphId "${msg.contextGraphId.slice(0, 120)}" does not match topic "${contextGraphId}", ignoring`);
        return 'deferred';
      }

      // Deduplicate: skip if we already successfully processed this UAL
      const dedupeKey = `${msg.ual}:${msg.txHash}`;
      if (this.processedUals.has(dedupeKey)) {
        this.log.info(ctx, `Finalization: already processed ${msg.ual}, skipping duplicate`);
        return 'already-confirmed';
      }

      if (
        msg.contentScopeVersion !== undefined
        && msg.contentScopeVersion !== 0
        && !isGraphScoped
      ) {
        this.log.warn(
          ctx,
          `Finalization: unsupported content scope version ${msg.contentScopeVersion}, ignoring`,
        );
        return 'deferred';
      }
      if (!msg.ual || !msg.txHash || (!isGraphScoped && msg.rootEntities.length === 0)) {
        this.log.warn(ctx, `Finalization: incomplete message (ual=${msg.ual}, txHash=${msg.txHash}, roots=${msg.rootEntities.length}, scope=${msg.contentScopeVersion ?? 0}), ignoring`);
        return 'deferred';
      }

      const blockNumber = protoToNumber(msg.blockNumber);
      const startKAId = protoToBigInt(msg.startKAId);
      const endKAId = protoToBigInt(msg.endKAId);

      // The publisher's `cd68fa689` fix threads the resolved on-chain CG id
      // into `targetContextGraphId` so receivers route SWM promotion into
      // the per-cgId `<cgName>/context/<cgId>/_meta` graph that the RS
      // prover reads from. Pre-fix publishers (or any publisher whose
      // `getContextGraphOnChainId` lookup returns null at gossip time) emit
      // `targetContextGraphId: undefined`, which used to silently downgrade
      // the receiver to legacy `<cgName>/_meta` promotion — leaving the
      // prover stuck on `kc-not-synced` until every publisher in the mesh
      // ships the fix. As a belt-and-braces for rolling upgrades we resolve
      // the id locally when the wire is empty; resolver failures or
      // not-on-chain CGs fall back to legacy behavior unchanged.
      let ctxGraphId = msg.targetContextGraphId || undefined;
      resolvedTargetContextGraphId = ctxGraphId;
      if (!ctxGraphId) {
        // Forward-prevention (RS cgId-race): resolve from CHAIN TRUTH first.
        // `getKAContextGraphId(batchId)` is authoritative and immune to the
        // local ontology-binding lag that strands KCs in legacy `/_meta` — the
        // root cause the heal-sweep exists to repair. Caching POSITIVE results
        // only (never a 0/miss) keeps a finalization that races ahead of its
        // on-chain KA->CG binding from being pinned to legacy forever.
        let batchIdForResolve = 0n;
        try { batchIdForResolve = protoToBigInt(msg.batchId); } catch { batchIdForResolve = 0n; }
        const cacheKey = batchIdForResolve > 0n ? batchIdForResolve.toString() : '';
        if (cacheKey && this.chainCgIdByBatchId.has(cacheKey)) {
          ctxGraphId = this.chainCgIdByBatchId.get(cacheKey);
          resolvedTargetContextGraphId = ctxGraphId;
        } else if (
          cacheKey && this.chain && this.chain.chainId !== 'none'
          && typeof this.chain.getKAContextGraphId === 'function'
        ) {
          try {
            const boundCg = await this.chain.getKAContextGraphId(batchIdForResolve);
            if (boundCg !== null && boundCg !== undefined && BigInt(boundCg) > 0n) {
              ctxGraphId = boundCg.toString();
              resolvedTargetContextGraphId = ctxGraphId;
              this.chainCgIdByBatchId.set(cacheKey, ctxGraphId); // POSITIVE-only
              this.log.info(ctx, `Finalization: resolved cgId from chain truth getKAContextGraphId(${batchIdForResolve})=${ctxGraphId}`);
            }
          } catch (err) {
            this.log.info(ctx, `Finalization: chain getKAContextGraphId(${batchIdForResolve}) failed (RPC lag?), falling back to local resolve: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Local name-based resolver — the existing belt-and-braces for rolling
        // upgrades when the chain method is absent/lagging.
        if (!ctxGraphId && this.resolveContextGraphOnChainId) {
          try {
            const resolved = await this.resolveContextGraphOnChainId(contextGraphId);
            if (resolved !== null && resolved !== undefined && String(resolved).length > 0) {
              ctxGraphId = String(resolved);
              resolvedTargetContextGraphId = ctxGraphId;
              this.log.info(ctx, `Finalization: gossip omitted targetContextGraphId; resolved locally to ${ctxGraphId} (defensive lookup)`);
            }
          } catch (err) {
            this.log.warn(ctx, `Finalization: defensive on-chain CG id lookup failed for ${contextGraphId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Validate sub-graph name from gossip — reject invalid names entirely
      let subGraphName: string | undefined;
      if (msg.subGraphName) {
        const sgVal = validateSubGraphName(msg.subGraphName);
        if (sgVal.valid) {
          subGraphName = msg.subGraphName;
        } else {
          this.log.warn(ctx, `Finalization: rejected message with invalid subGraphName "${msg.subGraphName}": ${sgVal.reason}`);
          return 'deferred';
        }
      }

      // Dedup guard: skip if this batch was already promoted (e.g. by ChainEventPoller).
      // Read-both (review F5): also ASK the label `_meta` — the minimal
      // per-cgId partition shape carries no `dkg:status` row.
      const targetMetaGraph = ctxGraphId
        ? contextGraphMetaUri(contextGraphId, ctxGraphId)
        : `did:dkg:context-graph:${contextGraphId}/_meta`;
      if (isGraphScoped) {
        const graphOutcome = await this.handleGraphScopedFinalization({
          rawMessage,
          candidate: graphAdmission!.value,
          contextGraphId,
          ctxGraphId,
          subGraphName,
          sourcePeerId,
          ctx,
        });
        if (graphOutcome === 'applied' || graphOutcome === 'already-confirmed') {
          this.markProcessed(dedupeKey);
        }
        return graphOutcome;
      }
      const alreadyPromoted = await this.isAlreadyConfirmed(
        msg.ual, targetMetaGraph, `did:dkg:context-graph:${contextGraphId}/_meta`,
      );
      if (alreadyPromoted) {
        this.markProcessed(dedupeKey);
        this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_already_confirmed', {
          ...msg,
          targetContextGraphId: ctxGraphId ?? msg.targetContextGraphId,
        }));
        this.log.info(ctx, `Finalization: ${msg.ual} already confirmed in ${ctxGraphId ? `context graph ${ctxGraphId}` : 'context graph'}, skipping`);
        return 'already-confirmed';
      }

      // #1549: read this KA's per-author SWM under-graphs first, widening to today's
      // unbounded read on empty-or-mismatch. All of the bound/widen policy — and the
      // reasoning for why it is safe — lives in storage's
      // `loadSharedMemorySliceWithKaBoundFallback`, which owns the widen.
      const { quads: sharedMemoryQuads, matched: merkleMatchedQuads } = await this.loadFinalizationSwmSlice(
        contextGraphId,
        msg.rootEntities,
        subGraphName,
        swmKaBoundDisabled() ? undefined : deriveSwmKaGraphBound(startKAId, endKAId),
        msg.kcMerkleRoot,
        async () => {
          const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, msg.rootEntities, subGraphName);
          const allowGeneratedCatalogFloor = await this.allowsGeneratedCatalogFloor(contextGraphId, ctxGraphId);
          return (quads) => this.sharedMemoryQuadsMatchingMerkle(
            contextGraphId,
            quads,
            privateRoots,
            msg.kcMerkleRoot,
            allowGeneratedCatalogFloor,
          );
        },
      );

      if (sharedMemoryQuads.length > 0) {
        if (merkleMatchedQuads) {
          const batchId = protoToBigInt(msg.batchId);
          // PR #845 review #9: derive `txIndex` from the verified receipt
          // (via `verifyOnChain`), NOT from gossip-supplied `msg.txIndex`.
          // The latter is trust-based; a peer can forge an inflated index
          // for a real publish `txHash` and lock out a legitimate
          // same-block update on the receiver. The verified value comes
          // from the on-chain log we matched (`log.transactionIndex`).
          const { verified, authorAddress, txIndex: verifiedTxIndex } = await this.verifyOnChain(
            msg.txHash, blockNumber, msg.kcMerkleRoot,
            msg.publisherAddress, startKAId, endKAId, ctx, ctxGraphId, batchId,
          );

          if (verified) {
            // Codex r5b — drop the rolling-upgrade legacy-publisher
            // fallback. Earlier rounds inferred same-graph intent from
            // `targetContextGraphId === local-on-chain-id-for(contextGraphId)`,
            // but Codex r5b correctly observed that signal is ambiguous:
            // it ALSO matches an explicit-remap-to-self publish (one where
            // the legacy publisher passed `subContextGraphId === ownCG's
            // own on-chain id` to deliberately drop the root copy). Both
            // shapes hit `targetContextGraphId === local id` on the wire,
            // so the fallback would re-add a root copy that the publisher
            // had intentionally removed — a data-isolation regression.
            //
            // The cure is worse than the disease: trading a hard
            // data-isolation bug for a soft query-discoverability gap is
            // unacceptable. Without an unambiguous version/intent signal
            // on the wire, a legacy publisher's same-graph publish stays
            // queryable on receivers via per-cgId partitions but not via
            // the bare `<cg>` label until the publisher upgrades to a
            // tristate-emitting build and re-emits. New publishers always
            // set the tristate (encoded with explicit KEEP/DROP) so the
            // gap is bounded by the upgrade window. PR #779 has not
            // shipped to any production peer yet, so this is the right
            // moment to harden the contract.
            const requestedKeepRootCopyOnLabel: boolean = msg.keepRootCopyOnLabel === true;
            // PR #845 review #9: tiebreaker comes from chain-truth.
            // verifyOnChain may not yield a txIndex if the matched event
            // shape didn't carry it (e.g. mocks). Fall back to 0 in that
            // case — matches pre-#845 ordering.
            const finalizationVersion: MaterializedVersion = {
              blockNumber,
              txIndex: typeof verifiedTxIndex === 'number' ? verifiedTxIndex : 0,
            };
            // PR #845 review #10: when same-graph dual-write is requested,
            // BOTH the per-cgId target meta and the root label meta
            // (`<cg>/_meta`) get rewritten. The pre-#845 code only guarded
            // the per-cgId target, so a stale finalization could pass that
            // check while an update had already stamped a newer version in
            // the root label meta — the dual-write then re-inserted the
            // old root-label data + meta on top of the update. Acquire the
            // label-meta lock too (when dual-writing), and downgrade to
            // per-cgId-only if the label projection is newer.
            const isDualWrite = requestedKeepRootCopyOnLabel
              && !!ctxGraphId
              && !subGraphName;
            const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
            // PR #845 review #7: TOCTOU — serialise check + promotion +
            // version stamp under the per-KA materialization lock so a
            // concurrent stale writer cannot interleave between our
            // `shouldApplyMaterialization` and `writeMaterializedVersion`.
            const outcome = await this.applyVerifiedFinalization({
              contextGraphId,
              sharedMemoryQuads: merkleMatchedQuads,
              ual: msg.ual,
              rootEntities: msg.rootEntities,
              publisherAddress: msg.publisherAddress,
              txHash: msg.txHash,
              blockNumber,
              startKAId,
              endKAId,
              batchId: protoToBigInt(msg.batchId),
              ctxGraphId,
              subGraphName,
              authorAddress,
              finalizationVersion,
              targetMetaGraph,
              defaultMeta,
              isDualWrite,
              ctx,
            });
            if (outcome === 'stale-target') {
              this.markProcessed(dedupeKey);
              this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_stale_target', {
                ...msg,
                targetContextGraphId: ctxGraphId ?? msg.targetContextGraphId,
                rootEntityCount: msg.rootEntities.length,
                swmStatementCount: merkleMatchedQuads.length,
                subGraphName,
                blockNumber,
                batchId,
                outcome,
                reason: 'newer update already materialized',
              }));
              this.log.info(ctx, `Finalization: a newer update is already materialised for ${msg.ual}, skipping stale publish promotion`);
              return 'already-confirmed';
            }
            this.markProcessed(dedupeKey);
            this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_applied', {
              ...msg,
              targetContextGraphId: ctxGraphId ?? msg.targetContextGraphId,
              rootEntityCount: msg.rootEntities.length,
              swmStatementCount: merkleMatchedQuads.length,
              subGraphName,
              blockNumber,
              batchId,
              outcome,
              retryable: false,
            }));
            this.log.info(ctx, `Finalization: promoted SWM snapshot to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'canonical'} for ${msg.ual} (tx=${msg.txHash.slice(0, 10)}…)`);
            return 'applied';
          }
          this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_verification_failed', {
            ...msg,
            targetContextGraphId: ctxGraphId ?? msg.targetContextGraphId,
            rootEntityCount: msg.rootEntities.length,
            swmStatementCount: merkleMatchedQuads.length,
            subGraphName,
            blockNumber,
            batchId,
            outcome: 'deferred',
            retryable: true,
            reason: 'on-chain verification failed',
            level: 'warn',
          }));
          this.log.info(ctx, `Finalization: on-chain verification failed for ${msg.ual}, will retry via ChainEventPoller`);
          return 'deferred';
        }
        this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_merkle_mismatch', {
          ...msg,
          targetContextGraphId: ctxGraphId ?? msg.targetContextGraphId,
          rootEntityCount: msg.rootEntities.length,
          swmStatementCount: sharedMemoryQuads.length,
          subGraphName,
          blockNumber,
          batchId: protoToBigInt(msg.batchId),
          outcome: 'deferred',
          retryable: true,
          reason: 'shared memory merkle root mismatch',
          level: 'warn',
        }));
        this.log.info(ctx, `Finalization: merkle mismatch for ${msg.ual}, shared memory data differs from published`);
      } else {
        this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_no_data', {
          ...msg,
          targetContextGraphId: ctxGraphId ?? msg.targetContextGraphId,
          rootEntityCount: msg.rootEntities.length,
          swmStatementCount: 0,
          subGraphName,
          blockNumber,
          batchId: protoToBigInt(msg.batchId),
          outcome: 'deferred',
          retryable: true,
          reason: 'no shared memory data',
          level: 'warn',
        }));
        this.log.info(ctx, `Finalization: no shared memory data for ${msg.ual}, peer missed SWM sharing`);
      }

      // Fallback: no matching shared memory data. The data will arrive via
      // the regular publish topic broadcast or ChainEventPoller sync.
      this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_payload_sync_required', {
        ...msg,
        targetContextGraphId: ctxGraphId ?? msg.targetContextGraphId,
        rootEntityCount: msg.rootEntities.length,
        swmStatementCount: sharedMemoryQuads.length,
        subGraphName,
        blockNumber,
        batchId: protoToBigInt(msg.batchId),
        outcome: 'deferred',
        retryable: true,
        reason: 'no matching SWM snapshot',
        level: 'warn',
      }));
      this.log.info(ctx, `Finalization: ${msg.ual} requires full payload sync (no matching SWM snapshot)`);
      return 'deferred';
    } catch (err) {
      if (err instanceof StoreSchedulerBusyError) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.lifecycle.record(ctx, finalizationLifecycleDecision('finalization_failed', {
        ...msg,
        contextGraphId: msg.contextGraphId || contextGraphId,
        targetContextGraphId: resolvedTargetContextGraphId ?? msg.targetContextGraphId,
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
   * Apply a V2 finalization without rediscovering RDF roots. The wire carries
   * only the canonical UAL, assertion version, counts, and one private
   * commitment; the physical SWM/VM graph names are derived locally.
   */
  private async handleGraphScopedFinalization(input: {
    rawMessage: Uint8Array;
    candidate: ParsedGraphScopedFinalization;
    contextGraphId: string;
    ctxGraphId?: string;
    subGraphName?: string;
    sourcePeerId?: string;
    ctx: OperationContext;
  }): Promise<FinalizationRecoveryApplyOutcome> {
    const {
      rawMessage,
      candidate: parsed,
      contextGraphId,
      ctxGraphId,
      subGraphName,
      sourcePeerId,
      ctx,
    } = input;
    const { msg } = parsed;
    const {
      scope,
      assertionVersion,
      blockNumber,
      startKAId,
      endKAId,
      batchId,
      publicTripleCount,
      privateTripleCount,
      privateMerkleRoot,
      wireAccessPolicy,
      allowedPeers,
    } = parsed;

    const graphManager = new GraphManager(this.store);
    await graphManager.ensureContextGraph(contextGraphId);
    if (subGraphName) await graphManager.ensureSubGraph(contextGraphId, subGraphName);
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
      return 'deferred';
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
      return 'deferred';
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
    const requestedAccessPolicy = head.accessPolicy
      ?? (trustedWireAccess ? wireAccessPolicy : undefined);
    const requestedAllowedPeers = head.accessPolicy
      ? head.allowedPeers
      : trustedWireAccess
        ? allowedPeers
        : [];

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
        return 'deferred';
      }
      if (layerVerification.status === 'merkle-mismatch') {
        this.log.warn(ctx, `Finalization: graph-scoped Merkle mismatch for ${scope.ual}`);
        return 'deferred';
      }
      if (layerVerification.status === 'head-mismatch') {
        this.log.warn(ctx, `Finalization: graph-scoped content does not match its durable head for ${scope.ual}`);
        return 'deferred';
      }
    }

    const verified = await this.verifyOnChain(
      msg.txHash,
      blockNumber,
      msg.kcMerkleRoot,
      msg.publisherAddress,
      startKAId,
      endKAId,
      ctx,
      ctxGraphId,
      batchId,
    );
    if (!verified.verified) {
      this.log.info(ctx, `Finalization: on-chain verification pending for graph-scoped KA ${scope.ual}`);
      return 'deferred';
    }
    await this.recovery.recordVerified({
      rawMessage,
      contextGraphId,
      ...(sourcePeerId ? { sourcePeerId } : {}),
      candidate: parsed,
    });
    const materializedVersion = {
      blockNumber,
      txIndex: verified.txIndex ?? 0,
    };
    if (vmVerification.status === 'verified') {
      const access = resolveGraphScopedAccessEnvelope(
        head,
        requestedAccessPolicy,
        requestedAllowedPeers,
      );
      const metadataState = await this.graphScopedMetadataState({
        contextGraphId,
        scope,
        head,
        merkleRoot: msg.kcMerkleRoot,
        batchId,
        expectedTxHash: msg.txHash,
        materializedVersion,
        accessPolicy: access.accessPolicy,
        allowedPeers: access.allowedPeers,
        authorAddress: verified.authorAddress,
        subGraphName,
      });
      if (metadataState === 'matching') {
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
      publisherAddress: msg.publisherAddress,
      txHash: msg.txHash,
      blockNumber,
      batchId,
      authorAddress: verified.authorAddress,
      materializedVersion,
      accessPolicy: requestedAccessPolicy,
      allowedPeers: requestedAllowedPeers,
      subGraphName,
      source: 'finalization',
      contentAlreadyMaterialized: vmVerification.status === 'verified',
      ctx,
    });
    if (outcome === 'stale') {
      this.log.info(ctx, `Finalization: newer graph-scoped assertion already materialized for ${scope.ual}`);
      return 'already-confirmed';
    }

    this.log.info(
      ctx,
      `Finalization: promoted graph-scoped KA ${scope.ual} (${publicTripleCount} public, ${privateTripleCount} private)`,
    );
    return 'applied';
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
    const result = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(graphUri)}> { ?s ?p ?o } }`,
    );
    const quads = result.type === 'quads'
      ? result.quads.map((quad) => ({ ...quad, graph: '' }))
      : [];
    if (quads.length !== input.publicTripleCount) {
      return { status: 'count-mismatch', graphUri, actualCount: quads.length };
    }
    const merkleRoot = computeFlatKCRoot(
      quads,
      input.privateMerkleRoot ? [input.privateMerkleRoot] : [],
    );
    if (!equalBytes(merkleRoot, input.expectedMerkleRoot)) {
      return { status: 'merkle-mismatch', graphUri };
    }
    if (
      input.expectedPublicQuadsDigest !== undefined
      && workspacePublicQuadsDigest(quads) !== input.expectedPublicQuadsDigest
    ) {
      return { status: 'head-mismatch', graphUri };
    }
    return { status: 'verified', graphUri, quads, merkleRoot };
  }

  /** Recognize exact confirmed VM state from surviving immutable metadata. */
  private async reconcileConfirmedGraphScopedVmWithoutWorkspaceHead(input: {
    contextGraphId: string;
    ual: string;
    merkleRoot: Uint8Array;
    kaId: bigint;
    versionBlock: number;
    subGraphName?: string;
  }, ctx: OperationContext): Promise<'already-confirmed' | 'no-swm' | undefined> {
    const stored = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(this.store, {
      contextGraphId: input.contextGraphId,
      ual: input.ual,
    });
    if (stored.state === 'absent') return undefined;
    if (stored.state === 'invalid') {
      this.log.warn(ctx, `Chain-reconcile: invalid confirmed graph-scoped metadata for ${input.ual}`);
      return 'no-swm';
    }

    const { envelope } = stored;
    let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    try {
      scope = createGraphKnowledgeAssetScope(input.ual, envelope.assertionVersion);
    } catch {
      return 'no-swm';
    }
    const packedKaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
    if (
      scope.ual !== input.ual
      || packedKaId !== input.kaId
      || envelope.batchId !== input.kaId
      || !equalBytes(envelope.merkleRoot, input.merkleRoot)
      || (input.subGraphName !== undefined && input.subGraphName !== envelope.subGraphName)
    ) {
      this.log.warn(
        ctx,
        `Chain-reconcile: confirmed graph-scoped metadata does not match chain identity for ${input.ual}`,
      );
      return 'no-swm';
    }

    const verification = await this.verifyExactGraphScopedLayer({
      contextGraphId: input.contextGraphId,
      scope,
      layer: MemoryLayer.VerifiableMemory,
      publicTripleCount: envelope.publicTripleCount,
      ...(envelope.privateMerkleRoot
        ? { privateMerkleRoot: envelope.privateMerkleRoot }
        : {}),
      expectedMerkleRoot: input.merkleRoot,
      ...(envelope.subGraphName ? { subGraphName: envelope.subGraphName } : {}),
    });
    if (verification.status !== 'verified') {
      this.log.warn(
        ctx,
        `Chain-reconcile: confirmed metadata exists but exact VM content is invalid for ${input.ual}`,
      );
      return 'no-swm';
    }

    await this.advanceExactGraphScopedVersion({
      contextGraphId: input.contextGraphId,
      scope,
      materializedVersion: { blockNumber: input.versionBlock, txIndex: 0 },
    });
    this.log.info(
      ctx,
      `Chain-reconcile: exact confirmed VM state survives without a workspace head for ${input.ual}`,
    );
    return 'already-confirmed';
  }

  /**
   * Resolve and promote the exact graph-scoped SWM assertion for a chain-known
   * KA. `undefined` means no V2 head exists and the caller may try the legacy
   * root-operation recovery path; every other result is authoritative for V2.
   */
  private async reconcileGraphScopedKC(input: {
    contextGraphId: string;
    ual: string;
    merkleRoot: Uint8Array;
    publisherAddress: string;
    kaId: bigint;
    versionBlock: number;
    authorAddress?: string;
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
      ual,
      merkleRoot,
      publisherAddress,
      kaId,
      versionBlock,
      authorAddress,
      subGraphName,
      trustedAssertionEvidence,
    } = input;
    // Historical UAL shapes can be valid inputs to the legacy root-scoped
    // recovery code but cannot name a V2 per-KA graph. Do not let the strict
    // V2 parser turn those into a terminal "corrupt head" result.
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
      if (!trustedAssertionEvidence) return 'no-swm';
      // Named recovery carries receipt/seal-validated immutable evidence. A
      // torn mutable head must not block exact recovery of that assertion.
    }
    if (!workspaceHead && !trustedAssertionEvidence) {
      return this.reconcileConfirmedGraphScopedVmWithoutWorkspaceHead({
        contextGraphId,
        ual,
        merkleRoot,
        kaId,
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
          accessPolicy: trustedAssertionEvidence.accessPolicy,
          allowedPeers: [...trustedAssertionEvidence.allowedPeers],
        }
      : workspaceHead!;
    const preserveNewerWorkspaceLifecycle = trustedAssertionEvidence !== undefined
      && workspaceHead !== undefined
      && BigInt(workspaceHead.assertionVersion)
        > BigInt(trustedAssertionEvidence.assertionVersion);
    const packedKaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
    if (scope.ual !== ual || packedKaId !== kaId) {
      this.log.warn(
        ctx,
        `Chain-reconcile: UAL-derived kaId ${packedKaId} does not match chain kaId ${kaId} for ${ual}`,
      );
      return 'no-swm';
    }
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
      const materializedVersion = { blockNumber: versionBlock, txIndex: 0 };
      const access = resolveGraphScopedAccessEnvelope(
        head,
        trustedAssertionEvidence?.accessPolicy,
        trustedAssertionEvidence?.allowedPeers,
      );
      const metadataState = await this.graphScopedMetadataState({
        contextGraphId,
        scope,
        head,
        merkleRoot,
        batchId: kaId,
        expectedTxHash: trustedAssertionEvidence?.transactionHash,
        accessPolicy: access.accessPolicy,
        allowedPeers: access.allowedPeers,
        authorAddress,
        subGraphName,
      });
      if (metadataState === 'matching') {
        await this.advanceExactGraphScopedVersion({
          contextGraphId,
          scope,
          materializedVersion,
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
          batchId: kaId,
          accessPolicy: 'ownerOnly',
          allowedPeers: [],
          authorAddress,
          subGraphName,
        });
        if (failClosedMetadataState === 'matching') {
          await this.advanceExactGraphScopedVersion({
            contextGraphId,
            scope,
            materializedVersion,
          });
          this.log.info(
            ctx,
            `Chain-reconcile: ${ual} retains fail-closed access without assertion evidence`,
          );
          return 'already-confirmed';
        }
      }
      if (!trustedAssertionEvidence) {
        this.log.info(
          ctx,
          `Chain-reconcile: exact VM metadata for ${ual} cannot be repaired without `
            + 'transaction provenance; deferring',
        );
        return 'verified-vm-metadata-pending';
      }
      // A confirmed publish may have committed the exact VM graph before its
      // graph-scoped metadata survived a crash. Reapply only the metadata tail:
      // SWM writers use a different lock, so this recovery path must not delete
      // a potentially newer staged assertion.
      const outcome = await this.applyVerifiedGraphScopedFinalization({
        contextGraphId,
        scope,
        verifiedQuads: vmVerification.quads,
        head,
        privateMerkleRoot,
        computedMerkleRoot: vmVerification.merkleRoot,
        publisherAddress,
        txHash: trustedAssertionEvidence.transactionHash,
        blockNumber: versionBlock,
        batchId: kaId,
        authorAddress,
        materializedVersion,
        accessPolicy: trustedAssertionEvidence?.accessPolicy,
        allowedPeers: trustedAssertionEvidence?.allowedPeers,
        subGraphName,
        source: 'chain-reconcile',
        contentAlreadyMaterialized: true,
        ctx,
      });
      if (outcome === 'stale') return 'stale-target';
      if (outcome === 'preserved-metadata') {
        this.log.info(
          ctx,
          `Chain-reconcile: retained confirmed metadata for an older same-root assertion ${ual}`,
        );
        return preserveNewerWorkspaceLifecycle ? 'stale-target' : 'already-confirmed';
      }
      this.log.info(ctx, `Chain-reconcile: exact VM graph already matches ${ual}; repaired metadata`);
      return preserveNewerWorkspaceLifecycle ? 'stale-target' : 'already-confirmed';
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

    // A generic sweep can prove content and the current chain root, but it has
    // no assertion-specific transaction provenance. Never synthesize confirmed
    // metadata with an empty transaction hash; named recovery or an exact VM
    // snapshot can complete the provenance-bearing transition.
    if (!trustedAssertionEvidence) {
      this.log.info(
        ctx,
        `Chain-reconcile: exact SWM content for ${ual} is verified but transaction `
          + 'provenance is unavailable; deferring VM promotion',
      );
      return 'verified-vm-metadata-pending';
    }

    const outcome = await this.applyVerifiedGraphScopedFinalization({
      contextGraphId,
      scope,
      verifiedQuads: swmVerification.quads,
      head,
      privateMerkleRoot,
      computedMerkleRoot: swmVerification.merkleRoot,
      publisherAddress,
      txHash: trustedAssertionEvidence.transactionHash,
      blockNumber: versionBlock,
      batchId: kaId,
      authorAddress,
      materializedVersion: { blockNumber: versionBlock, txIndex: 0 },
      accessPolicy: trustedAssertionEvidence?.accessPolicy,
      allowedPeers: trustedAssertionEvidence?.allowedPeers,
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
    publisherAddress: string;
    txHash: string;
    blockNumber: number;
    batchId: bigint;
    authorAddress?: string;
    materializedVersion: MaterializedVersion;
    accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
    allowedPeers?: string[];
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
      publisherAddress,
      txHash,
      blockNumber,
      batchId,
      authorAddress,
      materializedVersion,
      accessPolicy: requestedAccessPolicy,
      allowedPeers: requestedAllowedPeers = [],
      subGraphName,
      source,
      contentAlreadyMaterialized = false,
      ctx,
    } = input;
    const publicTripleCount = head.publicTripleCount;
    const privateTripleCount = head.privateTripleCount;
    const vmGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      scope,
      subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const {
      accessPolicy: safeAccessPolicy,
      allowedPeers: effectiveAllowedPeers,
    } = resolveGraphScopedAccessEnvelope(
      head,
      requestedAccessPolicy,
      requestedAllowedPeers,
    );

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
      // the later ordering stamp; never overwrite a newer assertion.
      const canRepairStaleExactMetadata = contentAlreadyMaterialized
        && confirmedAssertionVersion === scope.assertionVersion;
      if (incomingVersionIsStale && !canRepairStaleExactMetadata) {
        return 'stale' as const;
      }
      const preserveConfirmedMetadata = confirmedAssertionVersion !== undefined
        && confirmedAssertionVersion !== scope.assertionVersion;
      const metadataAccessPolicy = source === 'chain-reconcile'
        && requestedAccessPolicy === undefined
        ? 'ownerOnly'
        : safeAccessPolicy;
      const metadataAllowedPeers = metadataAccessPolicy === 'allowList'
        ? effectiveAllowedPeers
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

      let blockTimestamp = Math.floor(Date.now() / 1000);
      if (this.chain && typeof (this.chain as any).getBlockTimestamp === 'function') {
        try {
          blockTimestamp = await (this.chain as any).getBlockTimestamp(blockNumber);
        } catch {
          this.log.info(ctx, `Could not fetch block timestamp for block ${blockNumber}, using local time`);
        }
      }
      const provenance: OnChainProvenance = {
        txHash,
        blockNumber,
        blockTimestamp,
        publisherAddress,
        batchId,
        chainId: this.chain?.chainId ?? 'unknown',
      };
      const metadata = generateGraphKnowledgeAssetMetadata(
        {
          ual: scope.ual,
          contextGraphId,
          merkleRoot: computedMerkleRoot,
          publisherPeerId: head.publisherPeerId,
          accessPolicy: metadataAccessPolicy,
          ...(metadataAccessPolicy === 'allowList'
            ? { allowedPeers: metadataAllowedPeers }
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
        {
          status: 'confirmed',
          confirmation: { kind: 'transaction', provenance },
        },
      );
      const effectiveVersion = incomingVersionIsStale
        ? currentMaterializedVersion
        : materializedVersion;
      const vmQuads = verifiedQuads.map((quad) => ({ ...quad, graph: vmGraph }));
      const replaced = await tryReplaceGraphAndSubjectAtomically(
        this.store,
        vmGraph,
        vmQuads,
        metaGraph,
        scope.ual,
        [...metadata, materializedVersionQuad(metaGraph, scope.ual, effectiveVersion)],
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
    accessPolicy: GraphScopedAccessPolicy;
    allowedPeers: string[];
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
      accessPolicy,
      allowedPeers,
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
      const expectedAllowedPeers = [...new Set(allowedPeers)].sort();
      const actualAllowedPeers = [...new Set(storedAllowedPeers)].sort();
      const storedMaterializedVersion = oneLiteral(`${DKG_NS}materializedVersion`);
      const storedTransactionHash = oneLiteral(`${DKG_NS}transactionHash`);
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
        || storedTransactionHash === undefined
        || (expectedTxHash !== undefined
          && normalizedHex(storedTransactionHash) !== normalizedHex(expectedTxHash))
        || !parsedMaterializedVersion
        || !Number.isSafeInteger(Number(parsedMaterializedVersion[1]))
        || !Number.isSafeInteger(Number(parsedMaterializedVersion[2]))
        || (expectedMaterializedVersion !== undefined
          && storedMaterializedVersion !== expectedMaterializedVersion)
        || oneLiteral(`${DKG_NS}accessPolicy`) !== accessPolicy
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
      const result = await this.store.query(ask);
      return result.type === 'boolean' && result.value === true;
    } catch {
      return false;
    }
  }

  private finalizationSwmBucketUri(contextGraphId: string, subGraphName?: string): string {
    return subGraphName
      ? new GraphManager(this.store).sharedMemoryUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceGraphUri(contextGraphId);
  }

  /**
   * Read the finalization SWM slice, preferring this KA's per-author under-graphs
   * and widening to the complete read on empty-or-mismatch (#1549). The widen — and
   * the reasoning for why the bound is a safe pure accelerator (INV-1 is refuted
   * under root recurrence, so the bounded read may miss and must widen before the
   * caller records anything) — lives in storage's
   * `loadSharedMemorySliceWithKaBoundFallback`. This method only resolves the bucket
   * URI and the accept predicate; it is a thin finalization-specific adapter.
   *
   * #1098/#1099: replicas store gossiped SWM shares in the PER-KA graphs
   * `…/_shared_memory/{author}/{number}`, not the bare bucket, so the read must span
   * bucket + per-KA graphs or a replica reports "no shared memory data" and never
   * materialises the KA into VM.
   */
  private async loadFinalizationSwmSlice(
    contextGraphId: string,
    rootEntities: string[],
    subGraphName: string | undefined,
    kaGraphBound: SwmKaGraphBound | undefined,
    expectedMerkleRoot: Uint8Array,
    createAccept: () => Promise<(quads: Quad[]) => Quad[] | null>,
  ): Promise<{ quads: Quad[]; matched: Quad[] | null }> {
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return { quads: [], matched: null };
    const writeGen = this.graphWriteGen?.getWriteGen(`${contextGraphDataUri(contextGraphId)}/`);
    const key = [
      'finalization',
      contextGraphId,
      subGraphName ?? '',
      safeRoots.slice().sort().join('\u0001'),
      kaGraphBound ? `${kaGraphBound.agentAddress}:${kaGraphBound.startNumber}:${kaGraphBound.endNumber}` : '*',
      ethers.hexlify(expectedMerkleRoot),
      String(writeGen ?? 'unknown'),
    ].join('\u0000');
    return this.runScanSingleFlight(key, async () => {
      const { quads, accepted } = await loadSharedMemorySliceWithKaBoundFallback(
        this.store,
        this.finalizationSwmBucketUri(contextGraphId, subGraphName),
        { rootEntities: safeRoots },
        kaGraphBound,
        {
          sources: {
            bounded: SWM_SLICE_SOURCE_BOUNDED,
            widened: SWM_SLICE_SOURCE_WIDENED,
            unbounded: SWM_SLICE_SOURCE,
          },
          createAccept,
          queryOptions: { priority: 'background' },
          resultBudget: finalizationSwmResultBudget(),
        },
      );
      return { quads, matched: accepted };
    });
  }

  /** Complete (unbounded) SWM read for the chain-reconcile backstop. */
  private async getSharedMemoryQuadsForRoots(
    contextGraphId: string,
    rootEntities: string[],
    subGraphName?: string,
  ): Promise<Quad[]> {
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return [];
    return loadSelectedSharedMemoryQuads(
      this.store,
      this.finalizationSwmBucketUri(contextGraphId, subGraphName),
      { rootEntities: safeRoots },
      {
        querySource: SWM_SLICE_SOURCE,
        queryOptions: { priority: 'background' },
        resultBudget: finalizationSwmResultBudget(),
      },
    );
  }

  private runScanSingleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const scope = key.startsWith('finalization\u0000') ? 'finalization' : 'reconcile';
    const existing = this.scanSingleFlights.get(key) as Promise<T> | undefined;
    if (existing) {
      getMetrics().storeScanSingleFlightJoinsTotal.add(1, { scope });
      return existing;
    }
    getMetrics().storeScanSingleFlightActive.add(1, { scope });
    const running = work().finally(() => {
      if (this.scanSingleFlights.get(key) === running) this.scanSingleFlights.delete(key);
      getMetrics().storeScanSingleFlightActive.add(-1, { scope });
    });
    this.scanSingleFlights.set(key, running);
    return running;
  }

  private verifyMerkleMatch(sharedMemoryQuads: Quad[], privateRoots: Uint8Array[], expectedMerkleRoot: Uint8Array): boolean {
    const computedRoot = computeFlatKCRoot(sharedMemoryQuads, privateRoots);
    return ethers.hexlify(computedRoot) === ethers.hexlify(expectedMerkleRoot);
  }

  private sharedMemoryQuadsMatchingMerkle(
    contextGraphId: string,
    sharedMemoryQuads: Quad[],
    privateRoots: Uint8Array[],
    expectedMerkleRoot: Uint8Array,
    allowGeneratedCatalogFloor: boolean,
  ): Quad[] | null {
    if (this.verifyMerkleMatch(sharedMemoryQuads, privateRoots, expectedMerkleRoot)) {
      return sharedMemoryQuads;
    }

    if (!allowGeneratedCatalogFloor) return null;

    const withGeneratedCatalog = [
      ...sharedMemoryQuads,
      ...generatedPrivateCatalogFloorQuads(contextGraphId),
    ];
    if (this.verifyMerkleMatch(withGeneratedCatalog, privateRoots, expectedMerkleRoot)) {
      return withGeneratedCatalog;
    }

    return null;
  }

  private async storedOnChainContextGraphId(contextGraphId: string): Promise<string | undefined> {
    const ontologyGraph = contextGraphDataUri('ontology');
    const contextGraphUri = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <https://dkg.network/ontology#ContextGraphOnChainId> ?id } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    return stripOptionalLiteral(result.bindings[0]?.['id'])?.trim();
  }

  private async onChainContextGraphMatchesLocalId(
    contextGraphId: string,
    onChainCgId: string | bigint | undefined,
  ): Promise<boolean> {
    if (onChainCgId === undefined || onChainCgId === null) return false;
    const normalizedOnChainId = String(onChainCgId).trim();
    const normalizedContextGraphId = contextGraphId.trim();

    if (/^\d+$/.test(normalizedContextGraphId) && normalizedContextGraphId === normalizedOnChainId) return true;

    const liveNameHashMatches = async (): Promise<boolean> => {
      if (typeof this.chain?.getContextGraphNameHash !== 'function') return false;
      try {
        const nameHash = await this.chain.getContextGraphNameHash(BigInt(normalizedOnChainId));
        return typeof nameHash === 'string' &&
          nameHash.toLowerCase() === ethers.keccak256(ethers.toUtf8Bytes(normalizedContextGraphId)).toLowerCase();
      } catch {
        return false;
      }
    };

    let resolvedOnChainId: string | null | undefined;
    try {
      resolvedOnChainId = await this.resolveContextGraphOnChainId?.(contextGraphId);
    } catch {
      resolvedOnChainId = undefined;
    }
    if (sameBigIntLiteral(resolvedOnChainId, normalizedOnChainId)) {
      return typeof this.chain?.getContextGraphNameHash === 'function'
        ? liveNameHashMatches()
        : true;
    }

    const storedOnChainId = await this.storedOnChainContextGraphId(contextGraphId);
    if (sameBigIntLiteral(storedOnChainId, normalizedOnChainId)) {
      return typeof this.chain?.getContextGraphNameHash === 'function'
        ? liveNameHashMatches()
        : true;
    }

    return liveNameHashMatches();
  }

  private async allowsGeneratedCatalogFloor(contextGraphId: string, onChainCgId: string | bigint | undefined): Promise<boolean> {
    if (onChainCgId === undefined || onChainCgId === null) return false;
    if (!this.chain || this.chain.chainId === 'none') return false;
    if (typeof this.chain.getContextGraphAccessPolicy !== 'function') return false;
    if (!await this.onChainContextGraphMatchesLocalId(contextGraphId, onChainCgId)) return false;
    try {
      return Number(await this.chain.getContextGraphAccessPolicy(BigInt(onChainCgId))) === 1;
    } catch {
      return false;
    }
  }

  private async getPrivateRootsFromMeta(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<Uint8Array[]> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return [];

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const sparql = `SELECT ?entity ?root WHERE {
      GRAPH <${wsMetaGraph}> {
        VALUES ?entity { ${values} }
        ?entity <${DKG_NS}privateMerkleRoot> ?root .
      }
    }`;

    const roots: Uint8Array[] = [];
    try {
      const result = await this.store.query(sparql, { source: 'agent.finalization.privateRoots' });
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const hex = (row['root'] as string).replace(/^"(.*)".*$/, '$1').replace(/^0x/, '');
          if (hex.length === 64) {
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            roots.push(bytes);
          }
        }
      }
    } catch { /* metadata may not exist */ }
    return roots;
  }

  /**
   * Recover the publisher's `keepRootCopyOnLabel` decision for these roots from
   * SWM workspace meta. The publisher persists `<root> dkg:keepRootCopyOnLabel
   * "true"|"false"` at publish time — the durable equivalent of the gossip
   * envelope flag — and it replicates to subscribers alongside the per-root
   * `privateMerkleRoot`. Returns:
   *   - `true`      — a matched root explicitly kept the root-label copy,
   *   - `false`     — explicitly dropped (remap / explicit-subCG publish),
   *   - `undefined` — no signal persisted (legacy publish); the caller defaults
   *                   to per-cgId-only so a dropped root copy is never re-added.
   * An explicit `true` wins over `false` across the matched roots: a same-graph
   * publish demands the root copy exist.
   */
  private async getKeepRootCopySignal(
    contextGraphId: string,
    rootEntities: string[],
    subGraphName?: string,
  ): Promise<boolean | undefined> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return undefined;

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const sparql = `SELECT ?v WHERE {
      GRAPH <${assertSafeIri(wsMetaGraph)}> {
        VALUES ?root { ${values} }
        ?root <${KEEP_ROOT_COPY_PREDICATE}> ?v .
      }
    }`;
    try {
      const result = await this.store.query(sparql, { source: 'agent.finalization.keepRootCopySignal' });
      if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
      let sawFalse = false;
      for (const row of result.bindings) {
        const v = String(row['v']).replace(/^"(.*)".*$/, '$1');
        if (v === 'true') return true;
        if (v === 'false') sawFalse = true;
      }
      return sawFalse ? false : undefined;
    } catch {
      return undefined;
    }
  }

  private async getPublisherPeerIdFromMeta(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<string | undefined> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return undefined;

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const PROV = 'http://www.w3.org/ns/prov#';
    // GH #748: prefer the dedicated `dkg:publisherPeerId` field (peer-ID
    // literal); fall back to literal-form `prov:wasAttributedTo` for legacy
    // un-migrated SWM rows. Skip URI form — that's an agent DID, not a
    // peer ID, and downstream dials a libp2p peer with this value.
    //
    // `FILTER(BOUND(?peerId))` guards the LIMIT 1: without it, an op with
    // `rootEntity` but neither peer-ID source produces an unbound `?peerId`
    // that LIMIT could pick. The caller's `wsPeerId || publisherAddress`
    // fallback would then store an EVM address where a libp2p peer ID is
    // expected. With BOUND, only ops carrying a real peer-ID match.
    const sparql = `SELECT ?peerId WHERE {
      GRAPH <${wsMetaGraph}> {
        VALUES ?root { ${values} }
        ?op <${DKG_NS}rootEntity> ?root .
        OPTIONAL { ?op <${DKG_NS}publisherPeerId> ?pidField }
        OPTIONAL { ?op <${PROV}wasAttributedTo> ?attrField . FILTER(isLiteral(?attrField)) }
        BIND(COALESCE(?pidField, ?attrField) AS ?peerId)
        FILTER(BOUND(?peerId))
      }
    } LIMIT 1`;

    try {
      const result = await this.store.query(sparql, { source: 'agent.finalization.publisherPeerId' });
      if (result.type === 'bindings' && result.bindings.length > 0) {
        const raw = result.bindings[0]['peerId'] as string;
        const peerId = raw.replace(/^"(.*)".*$/, '$1');
        if (peerId && peerId !== 'unknown') return peerId;
      }
    } catch { /* shared memory metadata may not exist */ }
    return undefined;
  }

  /**
   * Shared SWM→VM promotion under the per-KA materialization lock(s).
   *
   * Extracted verbatim from the former `promoteUnderLocks`/`runUnderLocks`
   * inline closure in `handleFinalizationMessage` (PR #845's TOCTOU-safe
   * promotion) so BOTH the gossip path and the chain-driven reconciliation
   * path (`handleChainReconciledKC`) share one implementation. Behavior is
   * identical to the gossip path; the only change is that the captured locals
   * are now explicit params.
   *
   * Serialises check + promotion + version stamp under the per-KA lock so a
   * concurrent stale writer cannot interleave between `shouldApplyMaterialization`
   * and `writeMaterializedVersion`. When dual-writing (same-graph keep-root),
   * both the per-cgId target meta and the root-label meta are guarded; if the
   * root label has a newer projection (an applied update), the dual-write
   * portion is skipped so we don't clobber it.
   */
  private async applyVerifiedFinalization(input: {
    contextGraphId: string;
    sharedMemoryQuads: Quad[];
    ual: string;
    rootEntities: string[];
    publisherAddress: string;
    txHash: string;
    blockNumber: number;
    startKAId: bigint;
    endKAId: bigint;
    batchId: bigint;
    ctxGraphId?: string;
    subGraphName?: string;
    authorAddress?: string;
    finalizationVersion: MaterializedVersion;
    targetMetaGraph: string;
    defaultMeta: string;
    isDualWrite: boolean;
    ctx: OperationContext;
  }): Promise<'promoted' | 'stale-target'> {
    const {
      contextGraphId, sharedMemoryQuads, ual, rootEntities, publisherAddress,
      txHash, blockNumber, startKAId, endKAId, batchId, ctxGraphId, subGraphName,
      authorAddress, finalizationVersion, targetMetaGraph, defaultMeta, isDualWrite, ctx,
    } = input;

    const promoteUnderLocks = async (): Promise<'promoted' | 'stale-target'> => {
      if (!(await shouldApplyMaterialization(this.store, targetMetaGraph, ual, finalizationVersion))) {
        return 'stale-target';
      }
      let effectiveKeepRoot = isDualWrite;
      if (isDualWrite) {
        if (!(await shouldApplyMaterialization(this.store, defaultMeta, ual, finalizationVersion))) {
          // Per-cgId is stale-or-equal but ROOT label has a
          // newer projection (an applied update). Skip the
          // dual-write portion so we don't clobber it.
          effectiveKeepRoot = false;
          this.log.info(
            ctx,
            `Finalization: root-label projection is newer for ${ual}; downgrading to per-cgId-only promotion`,
          );
        }
      }
      await this.promoteSharedMemoryToCanonical(
        contextGraphId, sharedMemoryQuads, ual, rootEntities,
        publisherAddress, txHash, blockNumber, startKAId, endKAId,
        batchId, ctx, ctxGraphId, subGraphName,
        authorAddress,
        effectiveKeepRoot,
      );
      await writeMaterializedVersion(this.store, targetMetaGraph, ual, finalizationVersion);
      if (effectiveKeepRoot) {
        await writeMaterializedVersion(this.store, defaultMeta, ual, finalizationVersion);
      }
      return 'promoted';
    };
    // Nested per-graph locks. Acquired in sorted order to prevent
    // cross-deadlock with any other call site that might one day
    // also lock multiple metas.
    const lockOrder = isDualWrite
      ? [defaultMeta, targetMetaGraph].sort()
      : [targetMetaGraph];
    if (lockOrder.length === 1) {
      return withMaterializationLock(lockOrder[0], ual, promoteUnderLocks);
    }
    return withMaterializationLock(lockOrder[0], ual, () =>
      withMaterializationLock(lockOrder[1], ual, promoteUnderLocks),
    );
  }

  /**
   * Phase B — chain-driven VM reconciliation entry point.
   *
   * Promotes a chain-registered KC into VM WITHOUT a gossip FinalizationMessage.
   * The caller (the agent reconciler) has already established, from chain reads,
   * that this KC is registered to the CG and resolved its `merkleRoot` +
   * `publisherAddress` by kaId; it has also ensured the matching SWM snapshot is
   * present locally (fetching from the publisher/cores first if needed).
   *
   * Verification differs from the gossip path because the trigger here is
   * already chain truth, not an untrusted peer message:
   *   - `merkleRoot` + `publisherAddress` are DIRECT chain reads keyed by kaId
   *     (`getLatestMerkleRoot` / `getLatestMerkleRootPublisher`), so they need
   *     no re-scan of `KCCreated` events (that re-scan exists to defend the
   *     gossip wire, which we don't have).
   *   - the CG binding is confirmed by a direct `getKAContextGraphId(kaId)` read
   *     against the caller's `onChainCgId` — chain truth, no event scan, no
   *     `txHash`/block needed (the sweep path has neither).
   *   - integrity is the same flat-KC root recompute the gossip path verifies
   *     against: we find the local SWM operation whose recomputed root equals
   *     the chain `merkleRoot`.
   *
   * `getLatestMerkleRoot(kaId)` always returns the KA's LATEST state (after any
   * update), so the reconcile is "as of now" — we stamp the materialization
   * version with the current chain head block. A later real update (higher
   * block) supersedes correctly; a stale gossip for the original publish (lower
   * block) is correctly skipped. We do NOT re-broadcast on the finalization
   * topic — the chain has spoken.
   *
   * Returns:
   *   - `'promoted'`        — SWM snapshot verified + promoted to VM.
   *   - `'already-confirmed'` — VM already had it (idempotent; cursor may advance).
   *   - `'no-swm'`          — no local SWM snapshot matches the published
   *                            merkleRoot (caller leaves the cursor; sweep retries).
   *   - `'unverified'`      — chain couldn't confirm the CG binding (RPC lag /
   *                            reorg / no chain wired); caller leaves cursor.
   *   - `'stale-target'`    — a newer update is already materialised.
   */
  async handleChainReconciledKC(input: {
    /** Local CG id (topic/name), e.g. the value in `subscribedContextGraphs`. */
    contextGraphId: string;
    /** On-chain numeric CG id as a string. Required — drives the binding check + per-cgId meta routing. */
    onChainCgId: string;
    ual: string;
    merkleRoot: Uint8Array;
    publisherAddress: string;
    kaId: bigint;
    /** Chain head block at reconcile time — stamped as the materialization version. */
    versionBlock: number;
    /** Optional EIP-712 author recovered from chain (KnowledgeAssetCreated.author). */
    authorAddress?: string;
    /** Optional sub-graph the publish targeted (defaults to root workspace). */
    subGraphName?: string;
    /** Receipt/seal-validated assertion policy supplied only by named recovery. */
    trustedAssertionEvidence?: TrustedGraphScopedAssertionEvidence;
  }, ctx: OperationContext): Promise<
    | 'promoted'
    | 'already-confirmed'
    | 'no-swm'
    | 'unverified'
    | 'stale-target'
    | 'verified-vm-metadata-pending'
  > {
    const {
      contextGraphId, onChainCgId, ual, merkleRoot, publisherAddress,
      kaId, versionBlock, authorAddress, subGraphName, trustedAssertionEvidence,
    } = input;

    const ctxGraphId = onChainCgId.length > 0 ? onChainCgId : undefined;
    const targetMetaGraph = ctxGraphId
      ? contextGraphMetaUri(contextGraphId, ctxGraphId)
      : `did:dkg:context-graph:${contextGraphId}/_meta`;

    // Confirm the CG binding from chain truth (defends against a caller passing
    // a kaId that isn't actually registered to this CG, and against RPC lag /
    // reorg where the binding hasn't landed yet).
    if (!(await this.verifyChainCgBinding(kaId, onChainCgId, ctx))) {
      this.log.info(ctx, `Chain-reconcile: chain CG binding for ${ual} (ka=${kaId}) not confirmed against cg ${onChainCgId}; deferring to sweep retry`);
      return 'unverified';
    }

    const recoveredFromJournal = await this.recovery.replayMatching({
      chainId: this.chain?.chainId ?? 'none',
      contextGraphId,
      onChainCgId,
      ual,
      merkleRoot: ethers.hexlify(merkleRoot),
      kaId: kaId.toString(),
    });
    if (recoveredFromJournal) return 'already-confirmed';

    // V2 recovery is O(1) in the number of prior workspace operations: the
    // durable per-KA head names one exact assertion graph and carries its
    // constant-size commitment envelope. Only when no V2 head exists do we
    // enter the legacy root-operation scan below.
    const graphScopedOutcome = await this.reconcileGraphScopedKC({
      contextGraphId,
      ual,
      merkleRoot,
      publisherAddress,
      kaId,
      versionBlock,
      authorAddress,
      subGraphName,
      trustedAssertionEvidence,
    }, ctx);
    if (graphScopedOutcome !== undefined) return graphScopedOutcome;
    if (await this.hasGraphScopedMetadata(contextGraphId, ual)) {
      this.log.info(
        ctx,
        `Chain-reconcile: graph-scoped metadata exists for ${ual} but its durable workspace head is missing`,
      );
      return 'no-swm';
    }
    if (await this.isAlreadyConfirmed(
      ual,
      targetMetaGraph,
      `did:dkg:context-graph:${contextGraphId}/_meta`,
    )) {
      // No V2 workspace head or graph-scoped metadata exists. Preserve the
      // legacy read-both shortcut only after the exact V2 recovery path had the
      // opportunity to verify and repair a consumed-SWM publish.
      this.log.info(ctx, `Chain-reconcile: legacy ${ual} already confirmed in VM, skipping`);
      return 'already-confirmed';
    }

    // Recover the published roots from the local SWM snapshot. The gossip path
    // gets `rootEntities` from the wire; here there is no wire, and SWM meta
    // (created at share-time, before publish) carries no merkle root — so we
    // identify the matching WorkspaceOperation by RECOMPUTING each candidate's
    // KC root and comparing to the chain root. This is the same flat-KC root
    // the gossip path verifies against, so a match is an authoritative
    // merkle verification.
    const snapshot = await this.findSwmSnapshotForMerkleRoot(
      contextGraphId,
      merkleRoot,
      subGraphName,
      onChainCgId,
    );
    if (!snapshot) {
      this.log.info(ctx, `Chain-reconcile: no local SWM snapshot matches the published merkleRoot for ${ual}; deferring to sweep retry`);
      return 'no-swm';
    }
    const { rootEntities, sharedMemoryQuads } = snapshot;
    // The snapshot may have been found in a sub-graph the caller didn't know
    // about; promote into THAT namespace so the data lands in the right graph.
    const resolvedSubGraphName = snapshot.subGraphName ?? subGraphName;

    const finalizationVersion: MaterializedVersion = { blockNumber: versionBlock, txIndex: 0 };
    // Same-graph publishes dual-write the root `<cg>` label copy so label-scoped
    // reads (`agent.query(<cg label>)`) resolve. The gossip path learns this
    // from `keepRootCopyOnLabel` on the wire; the chain-driven path has no wire,
    // so the publisher persists the same decision into SWM workspace meta (which
    // replicates to subscribers alongside `privateMerkleRoot`). Recover it here
    // and mirror the gossip dual-write decision, so a subscriber that missed the
    // broadcast and recovers via the sweep still gets the root-label copy.
    // Absent (legacy publish, no persisted signal) → false: stay per-cgId only,
    // so a remap publish's deliberately-dropped root copy is never re-added.
    const keepRootCopyOnLabel = await this.getKeepRootCopySignal(
      contextGraphId, rootEntities, resolvedSubGraphName,
    );
    const isDualWrite = keepRootCopyOnLabel === true && !!ctxGraphId && !resolvedSubGraphName;
    const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;

    const outcome = await this.applyVerifiedFinalization({
      contextGraphId,
      sharedMemoryQuads,
      ual,
      rootEntities,
      publisherAddress,
      txHash: '',
      blockNumber: versionBlock,
      startKAId: kaId,
      endKAId: kaId,
      batchId: 0n,
      ctxGraphId,
      subGraphName: resolvedSubGraphName,
      authorAddress,
      finalizationVersion,
      targetMetaGraph,
      defaultMeta,
      isDualWrite,
      ctx,
    });

    if (outcome === 'stale-target') {
      this.log.info(ctx, `Chain-reconcile: a newer update is already materialised for ${ual}, skipping`);
      return 'stale-target';
    }
    this.log.info(ctx, `Chain-reconcile: promoted SWM snapshot to VM for ${ual} (ka=${kaId}, cg=${onChainCgId})`);
    return 'promoted';
  }

  /**
   * Confirm — from chain truth — that `kaId` is registered to `onChainCgId`,
   * via the direct `getKAContextGraphId(kaId)` storage read. Returns `false`
   * when no chain is wired, the read is unavailable, the binding doesn't match,
   * or the read throws (RPC lag) — all "can't confirm yet, retry later" cases.
   */
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

  /**
   * Find the local SWM snapshot whose KC merkle root matches the chain
   * `merkleRoot`, returning its root entities + shared-memory quads.
   *
   * SWM workspace meta is written at share-time (before publish), so it carries
   * no merkle root to look up by — only `?op a dkg:WorkspaceOperation ;
   * dkg:rootEntity <root>`. We therefore enumerate the candidate operations,
   * gather each one's SWM quads + private roots, recompute the flat-KC root
   * (`computeFlatKCRoot`, the same function the gossip path verifies against),
   * and return the first operation whose computed root equals the chain root.
   * A match is an authoritative merkle verification.
   *
   * Returns `null` when no local operation matches — either the snapshot hasn't
   * been synced yet (the caller's active-fetch missed / is in flight) or this
   * KA belongs to a publish this node never shared. Either way the B.2 sweep
   * retries later.
   *
   * Cost note (#1609): the recompute is memoized (`SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE`
   * + content digest). A *present* KA is resolved by its stamped root directly (fast
   * path, no scan); the fallback still enumerates every op — it must, because ops
   * assemble incrementally — but reuses each op's memoized root whenever its content
   * digest is unchanged, skipping the expensive `computeFlatKCRoot`. So steady-state
   * reconcile pays one bounded read + a cheap digest per op instead of a full merkle
   * recompute per op. This is a bridge; OT-RFC-60 makes the root a write-maintained,
   * indexed property (stamped once at op completion) so the fallback disappears
   * entirely. The generated-catalog-floor variant keeps the exhaustive recompute
   * (its match is over quads+floor, not the op's intrinsic stamped root).
   *
   * READ memo (#1609, 2026-07-11/12 testnet incident): the #1612 digest memo skips
   * only the merkle recompute — a never-match KA (a publish this node never shared,
   * exactly the beacon shape) still paid O(#ops) unbounded SWM CONSTRUCTs on EVERY
   * sweep tick, forever, stalling the event loop and dropping storage-ACK streams
   * on big stores. This wrapper adds a write-generation-gated NEGATIVE memo over
   * the whole scan (floor retry included): a "no match" verdict is replayed
   * without touching the store while (a) the adapter's write generation for the
   * CG's graph prefix is unchanged — new SWM only arrives via local writes
   * (gossip receive, publish share, active fetch), all of which pass the adapter
   * choke points and bump the generation, so the next call rescans — (b) the
   * catalog-floor eligibility is unchanged, and (c) the entry is younger than
   * `vmReconcileNegativeTtlMs()`. A MATCH is never memoized. Stores without the
   * write-generation capability disable the memo entirely (always scan), and a
   * restart clears it — every failure mode degrades to a rescan, never a miss.
   */
  private async findSwmSnapshotForMerkleRoot(
    contextGraphId: string,
    merkleRoot: Uint8Array,
    subGraphName?: string,
    onChainCgId?: string,
  ): Promise<{ rootEntities: string[]; sharedMemoryQuads: Quad[]; subGraphName?: string } | null> {
    const allowGeneratedCatalogFloor = await this.allowsGeneratedCatalogFloor(contextGraphId, onChainCgId);

    // Every graph the scan reads — root/sub-graph SWM buckets, their per-KA
    // under-graphs and `_shared_memory_meta` (op rows, `privateMerkleRoot`,
    // stamps) — lives under the CG's URI subtree, so one prefix covers all
    // namespaces of this call. Broader than strictly needed (any CG-local
    // write invalidates) — that only costs an extra rescan.
    const memoKey = `${contextGraphId}\0${subGraphName ?? ''}\0${ethers.hexlify(merkleRoot)}`;
    const swmWritePrefix = `${contextGraphDataUri(contextGraphId)}/`;
    const preScanGen = this.graphWriteGen?.getWriteGen(swmWritePrefix);
    if (preScanGen !== undefined) {
      const memo = this.negativeSnapshotMemo.get(memoKey);
      if (memo) {
        if (
          memo.writeGen === preScanGen &&
          memo.allowGeneratedCatalogFloor === allowGeneratedCatalogFloor &&
          Date.now() - memo.recordedAt < vmReconcileNegativeTtlMs()
        ) {
          // Refresh LRU recency; recordedAt stays — the TTL runs from the scan.
          this.negativeSnapshotMemo.delete(memoKey);
          this.negativeSnapshotMemo.set(memoKey, memo);
          return null;
        }
        this.negativeSnapshotMemo.delete(memoKey);
      }
    }

    const hit = await this.runScanSingleFlight(
      ['reconcile', memoKey, String(allowGeneratedCatalogFloor), String(preScanGen ?? 'unknown')].join('\u0000'),
      () => this.scanForSwmSnapshot(
        contextGraphId,
        merkleRoot,
        subGraphName,
        allowGeneratedCatalogFloor,
      ),
    );
    if (hit) return hit;

    if (preScanGen !== undefined) {
      // Record at the PRE-scan generation: any write that raced the scan (or
      // the scan's own best-effort restamps) flips the gate above, so the next
      // call rescans rather than replaying a verdict that may predate the write.
      this.negativeSnapshotMemo.set(memoKey, {
        writeGen: preScanGen,
        recordedAt: Date.now(),
        allowGeneratedCatalogFloor,
      });
      while (this.negativeSnapshotMemo.size > VM_RECONCILE_NEGATIVE_MEMO_MAX_ENTRIES) {
        const oldest = this.negativeSnapshotMemo.keys().next().value;
        if (oldest === undefined) break;
        this.negativeSnapshotMemo.delete(oldest);
      }
    }
    return null;
  }

  /** The authoritative full scan behind {@link findSwmSnapshotForMerkleRoot}. */
  private async scanForSwmSnapshot(
    contextGraphId: string,
    merkleRoot: Uint8Array,
    subGraphName: string | undefined,
    allowGeneratedCatalogFloor: boolean,
  ): Promise<{ rootEntities: string[]; sharedMemoryQuads: Quad[]; subGraphName?: string } | null> {
    // Caller knows the exact namespace → search only that one.
    if (subGraphName) {
      const hit = await this.findSwmSnapshotInNamespace(
        contextGraphId,
        merkleRoot,
        subGraphName,
        allowGeneratedCatalogFloor,
      );
      return hit ? { ...hit, subGraphName } : null;
    }

    // No namespace supplied (the chain-driven path never knows it). Try the
    // root workspace first, then fall back to every registered sub-graph —
    // otherwise a KA published into a named sub-graph would stay `no-swm`
    // forever because its SWM snapshot lives under a sub-graph meta graph,
    // not the root workspace meta. Return the namespace we matched in so the
    // caller promotes into the correct data graph.
    const rootHit = await this.findSwmSnapshotInNamespace(
      contextGraphId,
      merkleRoot,
      undefined,
      allowGeneratedCatalogFloor,
    );
    if (rootHit) return { ...rootHit, subGraphName: undefined };

    let subGraphNames: string[] = [];
    try {
      subGraphNames = await new GraphManager(this.store).listSubGraphs(contextGraphId);
    } catch { /* no sub-graphs / store can't enumerate */ }
    for (const sg of subGraphNames) {
      const hit = await this.findSwmSnapshotInNamespace(
        contextGraphId,
        merkleRoot,
        sg,
        allowGeneratedCatalogFloor,
      );
      if (hit) return { ...hit, subGraphName: sg };
    }
    return null;
  }

  /**
   * Search a single SWM namespace (root workspace when `subGraphName` is
   * undefined, otherwise the named sub-graph's shared-memory meta) for a
   * WorkspaceOperation whose recomputed flat-KC root matches `merkleRoot`.
   */
  private async findSwmSnapshotInNamespace(
    contextGraphId: string,
    merkleRoot: Uint8Array,
    subGraphName?: string,
    allowGeneratedCatalogFloor = false,
  ): Promise<{ rootEntities: string[]; sharedMemoryQuads: Quad[] } | null> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);

    // The generated-catalog-floor variant matches over quads+floor rather than an
    // op's intrinsic root, so it cannot be resolved by the stamped intrinsic root —
    // those CGs (a stable per-CG access policy) keep the exhaustive recompute scan.
    const useStampIndex = !allowGeneratedCatalogFloor;

    // FAST PATH — resolve a *present* KA whose op is stamped with the target root via
    // one indexed lookup (verified authoritatively), instead of recomputing every op's
    // root. On a miss it falls through to the memoized fallback scan below.
    if (useStampIndex) {
      const stamped = await this.findStampedSwmSnapshot(contextGraphId, wsMetaGraph, merkleRoot, subGraphName);
      if (stamped) return stamped;
    }

    // Enumerate EVERY op with its memoized (root, content-digest) stamp. We never
    // exclude on stamp-presence: a WorkspaceOperation is assembled incrementally via
    // entity-keyed data / private-root writes that don't rewrite the op subject, so a
    // stamp can be stale. The digest below makes reuse safe without a full recompute —
    // reuse the memoized root only when the op's current content still hashes to the
    // same cheap digest; any content change flips the digest → full recompute → the
    // op is re-evaluated and re-stamped. No op can be stranded by a stale stamp.
    type OpMemo = { roots: string[]; memoRoot?: string; memoDigest?: string };
    const opsBySubject = new Map<string, OpMemo>();
    try {
      const memoPatterns = useStampIndex
        ? `OPTIONAL { ?op <${SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE}> ?memoRoot . }
          OPTIONAL { ?op <${SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE}> ?memoDigest . }`
        : '';
      const result = await this.store.query(`SELECT ?op ?root ?memoRoot ?memoDigest WHERE {
        GRAPH <${assertSafeIri(wsMetaGraph)}> {
          ?op <${DKG_NS}rootEntity> ?root .
          ${memoPatterns}
        }
      }`);
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const op = typeof row['op'] === 'string' ? row['op'].replace(/^<(.*)>$/, '$1') : '';
          const root = typeof row['root'] === 'string' ? row['root'].replace(/^<(.*)>$/, '$1') : '';
          if (!op || !isSafeIri(root)) continue;
          const memo = opsBySubject.get(op) ?? { roots: [] };
          if (!memo.roots.includes(root)) memo.roots.push(root);
          if (memo.memoRoot === undefined && typeof row['memoRoot'] === 'string') {
            memo.memoRoot = row['memoRoot'].replace(/^"(.*)".*$/, '$1');
          }
          if (memo.memoDigest === undefined && typeof row['memoDigest'] === 'string') {
            memo.memoDigest = row['memoDigest'].replace(/^"(.*)".*$/, '$1');
          }
          opsBySubject.set(op, memo);
        }
      }
    } catch { /* SWM meta may not exist yet */ }

    if (opsBySubject.size === 0) return null;

    const opsSorted = [...opsBySubject.entries()].sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    // Ops whose content changed (or were never stamped) get a fresh (root, digest)
    // memo written after the loop — best-effort: a store hiccup on the memo must
    // never fail reconcile (correctness comes from the recompute here).
    const restamp = new Map<string, { root: string; digest: string }>();
    const targetHex = ethers.hexlify(merkleRoot);
    let hit: { rootEntities: string[]; sharedMemoryQuads: Quad[] } | null = null;
    for (const [op, memo] of opsSorted) {
      const roots = memo.roots;
      const sharedMemoryQuads = await this.getSharedMemoryQuadsForRoots(contextGraphId, roots, subGraphName);
      if (sharedMemoryQuads.length === 0) continue;
      const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, roots, subGraphName);
      if (useStampIndex) {
        const digest = this.swmContentDigest(sharedMemoryQuads, privateRoots);
        let computedHex: string;
        if (memo.memoRoot !== undefined && memo.memoDigest === digest) {
          // Content unchanged since the memo was written → reuse the root and skip
          // the expensive computeFlatKCRoot. The digest is a pure function of the
          // same (quads, privateRoots) computeFlatKCRoot consumes, so digest-equal
          // ⇒ root-equal.
          computedHex = memo.memoRoot;
        } else {
          computedHex = this.computeOpMerkleRoot(sharedMemoryQuads, privateRoots);
          restamp.set(op, { root: computedHex, digest });
        }
        if (computedHex === targetHex) {
          hit = { rootEntities: roots, sharedMemoryQuads };
          break;
        }
      } else {
        const merkleMatchedQuads = this.sharedMemoryQuadsMatchingMerkle(
          contextGraphId,
          sharedMemoryQuads,
          privateRoots,
          merkleRoot,
          allowGeneratedCatalogFloor,
        );
        if (merkleMatchedQuads) {
          return { rootEntities: roots, sharedMemoryQuads: merkleMatchedQuads };
        }
      }
    }
    await this.persistSwmStamps(wsMetaGraph, restamp);
    return hit;
  }

  /**
   * Cheap content fingerprint of an op's SWM snapshot — a pure function of the same
   * `(sharedMemoryQuads, privateRoots)` that `computeFlatKCRoot` consumes, but a
   * plain sorted-sha256 rather than the full skolemize + merkle construction. Used
   * only to decide whether a memoized root is still valid (digest-equal ⇒ the
   * content, hence its flat-KC root, is unchanged), never as an authoritative root.
   */
  /**
   * The op's intrinsic flat-KC merkle root (hex) — the expensive recompute the
   * content-digest memo lets us skip for unchanged ops. A named seam so callers and
   * tests can attribute the cost.
   */
  private computeOpMerkleRoot(sharedMemoryQuads: Quad[], privateRoots: Uint8Array[]): string {
    return ethers.hexlify(computeFlatKCRoot(sharedMemoryQuads, privateRoots));
  }

  private swmContentDigest(sharedMemoryQuads: Quad[], privateRoots: Uint8Array[]): string {
    // Unambiguous encoding (NUL field-sep, NL row-sep) matching the SWM-generation
    // fingerprint convention in `readVmReconcileSwmGen`, so distinct contents cannot
    // collide to the same digest and cause a wrong memoized-root reuse.
    const quadLines = sharedMemoryQuads
      .map((q) => [q.subject, q.predicate, typeof q.object === 'string' ? q.object : String(q.object), q.graph ?? ''].join('\0'))
      .sort();
    const privateLines = privateRoots.map((r) => ethers.hexlify(r)).sort();
    const payload = `${quadLines.join('\n')}\0\0private\0\0${privateLines.join('\n')}`;
    return createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  /**
   * Replace the (root, content-digest) memo for each op — delete-then-insert so an
   * op never accumulates duplicate/stale stamp triples. Best-effort; a failure here
   * leaves the memo absent (next pass recomputes), never wrong.
   */
  private async persistSwmStamps(wsMetaGraph: string, restamp: Map<string, { root: string; digest: string }>): Promise<void> {
    if (restamp.size === 0) return;
    try {
      const quads: Quad[] = [];
      for (const [op, { root, digest }] of restamp) {
        await this.store.deleteByPattern({ graph: wsMetaGraph, subject: op, predicate: SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE });
        await this.store.deleteByPattern({ graph: wsMetaGraph, subject: op, predicate: SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE });
        quads.push(
          { subject: op, predicate: SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE, object: `"${root}"`, graph: wsMetaGraph },
          { subject: op, predicate: SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE, object: `"${digest}"`, graph: wsMetaGraph },
        );
      }
      await this.store.insert(quads);
    } catch { /* memo is best-effort; the recompute is the source of truth */ }
  }

  /**
   * Fast path for `findSwmSnapshotInNamespace`: resolve the WorkspaceOperation
   * whose stamped intrinsic root equals `merkleRoot` without recomputing every
   * op's root. Re-verifies with `verifyMerkleMatch` (authoritative) so a stale
   * stamp can never promote the wrong snapshot; a stamp that no longer verifies is
   * dropped so the op falls back into the recompute scan this same pass.
   */
  private async findStampedSwmSnapshot(
    contextGraphId: string,
    wsMetaGraph: string,
    merkleRoot: Uint8Array,
    subGraphName?: string,
  ): Promise<{ rootEntities: string[]; sharedMemoryQuads: Quad[] } | null> {
    const targetHex = ethers.hexlify(merkleRoot);
    const rootsByOp = new Map<string, string[]>();
    try {
      const result = await this.store.query(`SELECT ?op ?root WHERE {
        GRAPH <${assertSafeIri(wsMetaGraph)}> {
          ?op <${SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE}> "${targetHex}" .
          ?op <${DKG_NS}rootEntity> ?root .
        }
      }`);
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const op = typeof row['op'] === 'string' ? row['op'].replace(/^<(.*)>$/, '$1') : '';
          const root = typeof row['root'] === 'string' ? row['root'].replace(/^<(.*)>$/, '$1') : '';
          if (!op || !isSafeIri(root)) continue;
          const list = rootsByOp.get(op) ?? [];
          list.push(root);
          rootsByOp.set(op, list);
        }
      }
    } catch { return null; }

    for (const [op, roots] of rootsByOp) {
      const sharedMemoryQuads = await this.getSharedMemoryQuadsForRoots(contextGraphId, roots, subGraphName);
      if (sharedMemoryQuads.length > 0) {
        const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, roots, subGraphName);
        if (this.verifyMerkleMatch(sharedMemoryQuads, privateRoots, merkleRoot)) {
          return { rootEntities: roots, sharedMemoryQuads };
        }
      }
      // The stamp no longer reflects the op's content — drop the whole (root, digest)
      // memo so the recompute scan re-evaluates and re-stamps it this pass.
      try {
        await this.store.deleteByPattern({ graph: wsMetaGraph, subject: op, predicate: SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE });
        await this.store.deleteByPattern({ graph: wsMetaGraph, subject: op, predicate: SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE });
      } catch { /* best-effort self-heal */ }
    }
    return null;
  }

  private async verifyOnChain(
    txHash: string,
    blockNumber: number,
    expectedMerkleRoot: Uint8Array,
    expectedPublisher: string,
    expectedStartKAId: bigint,
    expectedEndKAId: bigint,
    ctx: OperationContext,
    ctxGraphId?: string,
    expectedBatchId?: bigint,
  ): Promise<{ verified: boolean; authorAddress?: string; txIndex?: number }> {
    if (!this.chain || this.chain.chainId === 'none') return { verified: false };
    if (blockNumber <= 0) return { verified: false };

    try {
      // Verify KnowledgeBatchCreated or KCCreated (V10) at the specific block
      const batchFilter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated', 'KCCreated'],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      };

      let batchVerified = false;
      // Round 5 review §10 — capture the indexed `author` from the matched
      // KCCreated event so the caller can populate `dkg:Publication` /
      // `dkg:authoredBy` provenance on the replica side, mirroring the
      // originator. `address(0)` here is the unattributed-publish sentinel
      // (RFC-001 §3.6) and is correctly preserved.
      let authorAddress: string | undefined;
      // PR #845 review #9: capture the chain-truth `transactionIndex` from
      // the matched event so the materialization-version guard does not
      // have to trust the gossip-supplied `msg.txIndex` (which a peer can
      // inflate to lock out a legitimate same-block update).
      let verifiedTxIndex: number | undefined;
      for await (const event of this.chain.listenForEvents(batchFilter)) {
        if (event.blockNumber !== blockNumber) continue;
        if (txHash && (!event.data['txHash'] || (event.data['txHash'] as string).toLowerCase() !== txHash.toLowerCase())) {
          continue;
        }

        const eventMerkle = typeof event.data['merkleRoot'] === 'string'
          ? ethers.getBytes(event.data['merkleRoot'] as string)
          : event.data['merkleRoot'] as Uint8Array;
        const eventPublisher = (event.data['publisherAddress'] as string) ?? '';
        const eventStartKAId = BigInt(event.data['startKAId'] as string ?? '0');
        const eventEndKAId = BigInt(event.data['endKAId'] as string ?? '0');

        const merkleMatch = ethers.hexlify(eventMerkle) === ethers.hexlify(expectedMerkleRoot);
        const publisherMatch = eventPublisher.toLowerCase() === expectedPublisher.toLowerCase();
        const rangeMatch = eventStartKAId === expectedStartKAId && eventEndKAId === expectedEndKAId;

        if (merkleMatch && publisherMatch && rangeMatch) {
          batchVerified = true;
          const eventAuthor = (event.data['author'] as string) ?? '';
          if (eventAuthor) authorAddress = eventAuthor;
          const rawTxIdx = event.data['txIndex'];
          if (typeof rawTxIdx === 'number' && Number.isFinite(rawTxIdx) && rawTxIdx >= 0) {
            verifiedTxIndex = rawTxIdx;
          }
          break;
        }
      }

      if (!batchVerified) return { verified: false };

      // V10 publish registers the KC to the context graph internally
      // (no separate addBatchToContextGraph tx / ContextGraphExpanded event).
      // Skip the legacy ContextGraphExpanded check — the batch verification
      // above is sufficient for V10.
      if (ctxGraphId) {
        if (typeof this.chain.isV10Ready === 'function' && this.chain.isV10Ready()) {
          return { verified: true, authorAddress, txIndex: verifiedTxIndex };
        }
        try {
          const scanWindow = 256;
          const headBlock = typeof this.chain.getBlockNumber === 'function'
            ? await this.chain.getBlockNumber()
            : blockNumber + scanWindow;
          const cgFilter: EventFilter = {
            eventTypes: ['ContextGraphExpanded'],
            fromBlock: blockNumber,
            toBlock: Math.min(blockNumber + scanWindow, headBlock),
          };
          for await (const event of this.chain.listenForEvents(cgFilter)) {
            const eventCGId = String(event.data['contextGraphId'] ?? '');
            const eventBatchId = BigInt(event.data['batchId'] as string ?? '0');
            if (eventCGId === ctxGraphId && (expectedBatchId === undefined || eventBatchId === expectedBatchId)) {
              return { verified: true, authorAddress, txIndex: verifiedTxIndex };
            }
          }
          return { verified: false };
        } catch {
          return { verified: true, authorAddress, txIndex: verifiedTxIndex };
        }
      }

      return { verified: true, authorAddress, txIndex: verifiedTxIndex };
    } catch (err) {
      this.log.info(ctx, `Finalization on-chain verification pending (RPC may be lagging): ${err instanceof Error ? err.message : String(err)}`);
    }
    return { verified: false };
  }

  private async promoteSharedMemoryToCanonical(
    contextGraphId: string,
    sharedMemoryQuads: Quad[],
    ual: string,
    msgRootEntities: string[],
    publisherAddress: string,
    txHash: string,
    blockNumber: number,
    startKAId: bigint,
    endKAId: bigint,
    batchId: bigint,
    ctx: OperationContext,
    ctxGraphId?: string,
    subGraphName?: string,
    /**
     * EIP-712-attested author recovered from `KnowledgeAssetCreated.author`.
     * Round 5 review §10 — when set, the replica emits matching
     * `dkg:Publication` / `dkg:authoredBy` triples so agent-provenance via the
     * `_meta` triplestore is consistent across the originator and every replica.
     * `address(0)` and missing/empty values are skipped (preserves the
     * unattributed-publish path's no-author behaviour from RFC-001 §3.6).
     */
    authorAddress?: string,
    /**
     * PR #779 same-graph signal: when `true` the publisher kept a root-graph
     * copy of the canonical quads, so receivers mirror the dual-write so
     * label-scoped queries resolve. When `false` (or omitted on older
     * publishers) the publisher used the explicit-`subContextGraphId` /
     * remap path and deleted its own root copy on purpose — receivers
     * MUST NOT dual-write or they re-expose the KC under the source CG
     * label and double-count it in unscoped queries.
     */
    keepRootCopyOnLabel?: boolean,
  ): Promise<void> {
    const graphManager = new GraphManager(this.store);
    await graphManager.ensureContextGraph(contextGraphId);
    if (subGraphName) {
      await graphManager.ensureSubGraph(contextGraphId, subGraphName);
      const sgUri = contextGraphSubGraphUri(contextGraphId, subGraphName);
      const metaGraph = `did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta`;
      const alreadyRegistered = await this.store.query(
        `ASK { GRAPH <${metaGraph}> {
          <${assertSafeIri(sgUri)}> a <http://dkg.io/ontology/SubGraph> ;
            <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
            <http://dkg.io/ontology/createdBy> ?createdBy .
        } }`,
      );
      if (alreadyRegistered.type !== 'boolean' || !alreadyRegistered.value) {
        const regQuads = generateSubGraphRegistration({
          contextGraphId,
          subGraphName,
          createdBy: publisherAddress || 'finalization-discovery',
          timestamp: new Date(),
        });
        await this.store.insert(regQuads);
        this.markContextGraphMetaDirtyFromQuads?.(regQuads);
        this.log.info(ctx, `Finalization: auto-registered sub-graph "${subGraphName}" in context graph "${contextGraphId}"`);
      }
    }
    const dataGraph = subGraphName
      ? contextGraphSubGraphUri(contextGraphId, subGraphName)
      : ctxGraphId
        ? contextGraphDataUri(contextGraphId, ctxGraphId)
        : graphManager.dataGraphUri(contextGraphId);
    // Devnet test #774-followup (v10-rc-validation §5 gossip replication):
    // when `ctxGraphId` is set on a non-sub-graph publish, the canonical
    // data lands in the per-on-chain-id partition
    // `<cg>/context/<ctxGraphId>` only. The publisher path
    // (`dkg-publisher.ts` ~line 1382) intentionally ALSO writes the same
    // quads to the root `<cg>` graph "so `agent.query(label)` (which
    // resolves to `did:dkg:context-graph:<label>` without a
    // `/context/<id>` suffix) still finds the just-published triples"
    // (commit c2abbc9a). Replicas were never updated to mirror that
    // dual-write — so a CG-scoped query against a label on a recipient
    // node finds 0 bindings even though the data is local in
    // `<cg>/context/<ctxGraphId>`. The query engine cannot widen its
    // allow set to `<cg>/context/<num>` without a CG-registry lookup
    // (id-prefix collisions, see PR #776 r6 in dkg-query-engine.ts).
    // Mirroring the publisher's same-graph dual-write fixes the
    // visibility asymmetry without re-introducing that ambiguity.
    //
    // Critical scoping (Codex review on PR #779): the recipient dual-write
    // MUST only fire for same-graph publishes (the publisher kept the
    // root copy too). Explicit-`subContextGraphId` / remap publishes
    // delete the root copy on purpose (`dkg-publisher.ts` ~line 1393),
    // and a recipient that re-adds it would re-expose the KC under the
    // source CG's label on every replica — leaking remap intent and
    // double-counting the same triples in unscoped queries. The
    // publisher signals same-graph vs remap on the wire via
    // `keepRootCopyOnLabel`; missing/false (older publishers, or any
    // remap publish) → no dual-write.
    const rootDataGraphForLabel = (!subGraphName && ctxGraphId && keepRootCopyOnLabel === true)
      ? graphManager.dataGraphUri(contextGraphId)
      : null;

    // Compute canonical quads now, but defer the `store.insert` until AFTER
    // the confirmed-meta write and SWM cleanup (see bottom of this method).
    //
    // Rationale: on a replica the three store mutations (canonical insert,
    // confirmed-meta insert, SWM cleanup) happen as three sequential awaits.
    // Readers polling the canonical graph (e.g. downstream consumers waiting
    // for "KC landed") can observe the canonical insert before the meta flip
    // to `confirmed` or before SWM has been drained, producing a visible
    // "data-without-confirmed-meta" intermediate state that is wrong from a
    // causal-consistency standpoint (the whole point of the finalization
    // gossip is that by the time data is canonical on a replica, the chain
    // proof is durable too). On fast dev machines the window is sub-
    // millisecond and invisible; on slower CI runners it widens to ~70 ms
    // and a poll that happens to land there sees `tentative` instead of
    // `confirmed` (flipped the `Tornado EVM integration: agent`
    // e2e-finalization suite red on every PR-224 run since the
    // sync-refactor merge at `bc65c3ae`).
    //
    // Ordering meta+cleanup BEFORE canonical insert makes the public state
    // transition single-stepped from an observer's point of view: either
    // you don't see the data yet, or you see data + confirmed meta + empty
    // SWM. The only user-visible partial state that remains (confirmed
    // meta + no data) is naturally recovered by `isAlreadyConfirmed` on the
    // next retry path, and it's strictly less broken than the converse.
    const canonicalQuads = sharedMemoryQuads.map(q => ({ ...q, graph: dataGraph }));

    const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, msgRootEntities, subGraphName);
    const merkleRoot = computeFlatKCRoot(canonicalQuads, privateRoots);

    const partitioned = skolemizeByEntity(canonicalQuads);
    const localRootSet = new Set(partitioned.keys());

    const rootEntities = msgRootEntities.length > 0
      ? msgRootEntities
      : [...partitioned.keys()];

    if (msgRootEntities.length > 0) {
      const msgSet = new Set(msgRootEntities);
      const extraInMsg = msgRootEntities.filter(r => !localRootSet.has(r));
      let generatedCatalogRootSet = new Set<string>();
      try {
        generatedCatalogRootSet = new Set(
          splitTrustedGeneratedCatalogRootMap(
            partitioned,
            generatedPrivateCatalogTripleKeys(contextGraphId),
          ).generatedCatalogRootEntities,
        );
      } catch {
        generatedCatalogRootSet = new Set<string>();
      }
      const missingInMsg = [...localRootSet].filter(
        r => !msgSet.has(r) && !generatedCatalogRootSet.has(r),
      );
      if (extraInMsg.length > 0 || missingInMsg.length > 0) {
        this.log.warn(ctx, `Finalization: root entity set mismatch — extra in msg: [${extraInMsg.join(', ')}], missing: [${missingInMsg.join(', ')}]`);
      }
    }
    const kaMetadata: KAMetadata[] = [];

    // GH #936 — assign per-root tokenIds over a CANONICAL (lexicographic) root
    // order, NOT the SPARQL/gossip binding order. oxigraph binding order is
    // store-history-dependent, so two replicas reconciling the same KC from
    // chain would otherwise mint divergent root→tokenId maps. These tokenIds are
    // local compatibility labels (the on-chain KA count is 1, no on-chain
    // dependency — see dkg-publisher.ts), so a content-derived sort makes the
    // map a pure function of the root SET: identical on every replica and on
    // both the gossip and chain-reconcile promotion paths.
    const orderedRoots = [...rootEntities].sort(compareRootIris);

    for (let tokenIdx = 0; tokenIdx < orderedRoots.length; tokenIdx++) {
      const rootEntity = orderedRoots[tokenIdx];
      const entityQuads = partitioned.get(rootEntity) ?? [];
      if (entityQuads.length === 0) continue;
      kaMetadata.push({
        rootEntity,
        kcUal: ual,
        tokenId: BigInt(tokenIdx + 1),
        publicTripleCount: entityQuads.length,
        privateTripleCount: 0,
        privateMerkleRoot: undefined,
      });
    }

    const wsPeerId = await this.getPublisherPeerIdFromMeta(contextGraphId, msgRootEntities, subGraphName);
    // Round 5 review §10 — propagate the on-chain-attested author into the
    // confirmed `_meta` block so replicas emit a `prov:wasAttributedTo`
    // matching the originator's. We treat `address(0)` (the
    // unattributed-publish sentinel) as "no author" by skipping the field,
    // so the legacy no-author behaviour is preserved verbatim. (The former
    // `dkg:Publication` / `dkg:authoredBy` mirror was dropped — RFC
    // ka-metadata-trim Phase 1, zero readers.)
    const isUnattributed = !authorAddress
      || authorAddress === '0x0000000000000000000000000000000000000000'
      || authorAddress.toLowerCase() === '0x0000000000000000000000000000000000000000';
    const kcMeta: KCMetadata = {
      ual,
      contextGraphId,
      merkleRoot,
      publisherPeerId: wsPeerId || publisherAddress,
      timestamp: new Date(),
      subGraphName,
      ...(isUnattributed
        ? {}
        : { authorAddress }),
    };

    let blockTimestamp = Math.floor(Date.now() / 1000);
    if (this.chain && typeof (this.chain as any).getBlockTimestamp === 'function') {
      try {
        blockTimestamp = await (this.chain as any).getBlockTimestamp(blockNumber);
      } catch {
        this.log.info(ctx, `Could not fetch block timestamp for block ${blockNumber}, using local time`);
      }
    }

    const provenance: OnChainProvenance = {
      txHash,
      blockNumber,
      blockTimestamp,
      publisherAddress,
      batchId,
      chainId: this.chain?.chainId ?? 'unknown',
    };

    // Remove any existing tentative status for this UAL before inserting
    // confirmed metadata. Two graph locations can carry it on this replica:
    //   1. Root `<cg>/_meta` — gossip-publish-handler ALWAYS writes
    //      `generateTentativeMetadata(...)` here (via `getTentativeStatusQuad`,
    //      which hardcodes the root `_meta` graph). This applies to every
    //      gossip-replicated KC regardless of `ctxGraphId` / dual-write mode.
    //   2. Per-cgId `<cg>/context/<id>/_meta` — older code paths (and any
    //      future writer that respects the same partition split as canonical
    //      data) may park a tentative quad here when `ctxGraphId` is set.
    //
    // Codex r5 on PR #779: the previous form mutated `tentativeQuad.graph`
    // to the per-cgId URI when `ctxGraphId` was set and deleted ONLY that
    // copy. The root tentative survived. With the same-graph dual-write
    // path (`keepRootCopyOnLabel === true`) we then re-inserted confirmed
    // `_meta` into root `<cg>/_meta`, leaving `tentative` AND `confirmed`
    // status quads coexisting on the same UAL in the root meta graph —
    // label-scoped status reads were non-deterministic. Even on the
    // `keepRootCopyOnLabel === false` path the leftover root tentative was
    // wrong (the publisher had moved/dropped its root copy on remap).
    //
    // Fix: always queue the root tentative for deletion AND, when ctxGraphId
    // is set, also queue the per-cgId variant. Single `store.delete` call so
    // all stale tentative copies are reaped in one shot — `delete` no-ops on
    // missing quads, so it's safe to enumerate both regardless of which
    // writer actually populated them.
    const rootTentativeQuad = getTentativeStatusQuad(ual, contextGraphId);
    const tentativesToDelete = [rootTentativeQuad];
    if (ctxGraphId) {
      tentativesToDelete.push({
        ...rootTentativeQuad,
        graph: contextGraphMetaUri(contextGraphId, ctxGraphId),
      });
    }
    try {
      await this.store.delete(tentativesToDelete);
    } catch { /* tentative status may not exist */ }

    let metaQuads = generateConfirmedFullMetadata(kcMeta, kaMetadata, provenance);

    // GH #936 — append the SHARED deterministic per-root token rows (no-op for
    // single-root). This is the SAME helper the publisher uses on the originator
    // path, so a locally-published and a chain-reconciled multi-root KC expose
    // an identical, queryable rootEntity→tokenId map. graph = the default
    // `<cg>/_meta` so the ctxGraphId remap below routes them to the per-cgId
    // `_meta` (and dual-writes a root copy when keepRootCopyOnLabel).
    metaQuads.push(
      ...buildDeterministicTokenRows(ual, kaMetadata, `did:dkg:context-graph:${contextGraphId}/_meta`),
    );
    if (ctxGraphId) {
      const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const targetMeta = contextGraphMetaUri(contextGraphId, ctxGraphId);
      // Codex r3 on PR #779: the publisher's same-graph path keeps the
      // confirmed `_meta` triples in BOTH the root `<cg>/_meta` and
      // the per-cgId `<cg>/context/<cgId>/_meta` graphs (see the
      // matching dual-write in `dkg-publisher.ts` ~line 1419, comment
      // "on remap publishes the original copy at `<NAME>/_meta` is
      // also moved; on same-graph publishes we leave the default copy
      // in place"). Replicas were only writing the per-cgId copy, so
      // label-only `_meta` reads (status / UAL / authoredBy lookups
      // that don't know the on-chain id) diverged between publisher
      // and recipients. Mirror the publisher's same-graph dual-write
      // here too — gated on the same `keepRootCopyOnLabel` signal as
      // the data-graph dual-write below, and folded into a single
      // `store.insert` for the same retry-safety reason (`_meta`
      // tentative→confirmed flip is supposed to be the durable point
      // post-this-call; splitting the writes would re-introduce a
      // partial-state window).
      if (keepRootCopyOnLabel === true) {
        const rootCopies = metaQuads
          .filter((q) => q.graph === defaultMeta)
          .map((q) => ({ ...q }));
        const perCgIdCopies = metaQuads.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: targetMeta } : q,
        );
        metaQuads = [...perCgIdCopies, ...rootCopies];
      } else {
        metaQuads = metaQuads.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: targetMeta } : q,
        );
      }
    }
    // #1233 follow-up — bound agents/_meta: this confirmed-metadata restatement
    // is load-bearing (prior-root cleanup + the tentative→confirmed flip), so it
    // cannot be skipped for the agents CG. INSERT then PRUNE (insert-first) via
    // the helper: the just-inserted UAL is `recordUal` so the prune protects it,
    // and a post-insert prune failure is swallowed (warned) inside the helper so
    // it can never abort this promotion. agents/_meta
    // stays O(agents), not O(agents × heartbeats); no-op prune for every other CG
    // (so it just inserts). For the agents CG `ctxGraphId` is always undefined
    // (never on-chain), so `metaQuads` land in the default `<cg>/_meta` graph —
    // the graph bounded here.
    // NOTE: the agents CG is always-tentative and never confirms on-chain, so in
    // practice this promotion is not reached for it (see report); this is a
    // defensive, lifecycle-preserving bound that keeps the invariant robust.
    // The bound derives its lock + prune roots from `metaQuads` itself, so the
    // dropped zero-public-triple roots (the `continue` above) are naturally excluded
    // from the prune — it can only evict superseded records for roots THIS record
    // covers, never zero a root the record omits. (Previously this call passed a
    // separate rootEntities list, which risked exactly that drift.)
    await insertBoundedAgentRegistryMeta({
      store: this.store,
      contextGraphId,
      metaGraph: `did:dkg:context-graph:${contextGraphId}/_meta`,
      recordUal: ual,
      metadataQuads: metaQuads,
    });

    // Clean up promoted shared memory entries
    const sharedMemoryGraph = subGraphName
      ? graphManager.sharedMemoryUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceGraphUri(contextGraphId);
    const swmMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    // #1099: replicas hold the gossiped SWM copy in PER-KA graphs
    // `…/_shared_memory/{author}/{number}` (workspace-handler.ts ~line 987),
    // but this cleanup only drained the bare bucket. The stale per-KA copy
    // survived every publish, kept being served to late subscribers via the
    // PROTOCOL_SYNC SWM responder (which reads the whole `…/_shared_memory/`
    // prefix), and re-poisoned even the publisher's own SWM on resync —
    // publisher and replicas permanently disagreed about SWM content.
    // Mirror DKGPublisher's `swmGraphsUnder`: drain the bucket AND every
    // graph under its `/` prefix.
    const allGraphs = await this.store.listGraphs();
    const swmGraphsForClear = allGraphs.filter(
      (g) => g === sharedMemoryGraph || g.startsWith(`${sharedMemoryGraph}/`),
    );
    for (const rootEntity of rootEntities) {
      for (const g of swmGraphsForClear) {
        await this.store.deleteByPattern({ graph: g, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(g, rootEntity + '/.well-known/genid/');
        await this.store.deleteByPattern({
          graph: g, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
        });
      }
      await this.store.deleteByPattern({
        graph: swmMetaGraph, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
      });
      await this.deleteMetaForRoot(swmMetaGraph, rootEntity);
    }

    // Canonical insert LAST — see the comment above `const canonicalQuads`.
    // By the time any reader observes these quads in the canonical graph,
    // `_meta` already carries `confirmed` status + chain provenance and the
    // matching SWM entries have been drained.
    //
    // Codex r2 on PR #779: when same-graph dual-write is in play, both
    // copies (per-cgId partition + root label graph) MUST land in a single
    // `store.insert` so a crash or store-write failure between them
    // cannot leave the replica with the per-cgId copy but no root copy.
    // The previous split form would be skipped on retry by
    // `isAlreadyConfirmed()` (`_meta` already confirmed) and the root
    // copy would never be back-filled — a permanent label-scoped query
    // miss on that replica. Folding both into one insert call ties their
    // durability to the same store-write transaction (Oxigraph's `load`
    // and SPARQL-backend bulk insert are both atomic at the call level).
    const allCanonicalQuads = rootDataGraphForLabel
      ? [
          ...canonicalQuads,
          ...canonicalQuads.map(q => ({ ...q, graph: rootDataGraphForLabel })),
        ]
      : canonicalQuads;
    await this.store.insert(allCanonicalQuads);

    this.log.info(ctx, `Promoted ${canonicalQuads.length} quads from shared memory to canonical for ${ual}`);
    this.eventBus?.emit(DKGEvent.MEMORY_GRAPH_CHANGED, {
      contextGraphId,
      layers: ['swm', 'vm'],
      subGraphName,
      operation: 'verifiable_memory_finalized',
      source: 'finalization',
      counts: {
        roots: rootEntities.length,
        triples: canonicalQuads.length,
      },
    });
  }

  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const result = await this.store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(metaGraph)}> { ?op ${ENTITY_PRED_ALT} <${assertSafeIri(rootEntity)}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;
      // OT-RFC-43 §10.1 — dual-write migration: remove BOTH the legacy
      // dkg:rootEntity and the new dkg:entity for this op/entity pair.
      await this.store.delete([
        { subject: op, predicate: DKG_ROOT_ENTITY_LEGACY, object: rootEntity, graph: metaGraph },
        { subject: op, predicate: DKG_ENTITY, object: rootEntity, graph: metaGraph },
      ]);
      const remaining = await this.store.query(
        `SELECT (COUNT(DISTINCT ?r) AS ?c) WHERE { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(op)}> ${ENTITY_PRED_ALT} ?r } }`,
      );
      const rawCount = remaining.type === 'bindings' && remaining.bindings[0]?.['c'];
      const countVal = typeof rawCount === 'string'
        ? Number(rawCount.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, ''))
        : NaN;
      if (countVal === 0) {
        await this.store.deleteByPattern({ graph: metaGraph, subject: op });
      }
    }
  }
}

/**
 * Public compatibility boundary. New call sites use named options; the legacy
 * positional signature remains accepted here without leaking into the core.
 */
export class FinalizationHandler extends FinalizationHandlerCore {
  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    options?: FinalizationHandlerOptions,
  );
  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    eventBus?: EventBus,
    resolveContextGraphOnChainId?: ResolveContextGraphOnChainId,
    markContextGraphMetaDirtyFromQuads?: MarkContextGraphMetaDirtyFromQuads,
    lifecycleLogOptions?: FinalizationLifecycleLogOptions,
    recoveryJournal?: FinalizationRecoveryJournal,
  );
  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    optionsOrEventBus?: FinalizationHandlerOptions | EventBus,
    legacyResolveContextGraphOnChainId?: ResolveContextGraphOnChainId,
    legacyMarkContextGraphMetaDirtyFromQuads?: MarkContextGraphMetaDirtyFromQuads,
    legacyLifecycleLogOptions?: FinalizationLifecycleLogOptions,
    legacyRecoveryJournal?: FinalizationRecoveryJournal,
  ) {
    super(store, chain, normalizeFinalizationHandlerOptions(
      optionsOrEventBus,
      legacyResolveContextGraphOnChainId,
      legacyMarkContextGraphMetaDirtyFromQuads,
      legacyLifecycleLogOptions,
      legacyRecoveryJournal,
    ));
  }
}

function protoToNumber(val: number | bigint | { low: number; high: number; unsigned: boolean }): number {
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'number') return val;
  return ((val.high >>> 0) * 0x100000000) + (val.low >>> 0);
}

function protoToBigInt(val: string | number | bigint | { low: number; high: number; unsigned: boolean }): bigint {
  if (typeof val === 'string') return BigInt(val);
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  return (BigInt(val.high >>> 0) << 32n) | BigInt(val.low >>> 0);
}
