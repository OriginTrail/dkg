import type {
  CanonicalFinalizationReceipt,
  CanonicalFinalizationReceiptResolution,
  ChainAdapter,
  EventFilter,
} from '@origintrail-official/dkg-chain';
import {
  decodeFinalizationMessage,
  getMetrics,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import {
  VerifiedGraphScopedFinalizationEvidenceCodec,
  parseGraphScopedFinalization,
  type GraphScopedAccessPolicy,
  type ParsedGraphScopedFinalization,
  type VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';
import type {
  FinalizationRecoveryEntry,
  FinalizationRecoveryHealth,
  FinalizationRecoverySettledPublisherUpgradeResult,
  FinalizationRecoveryStore,
} from './finalization-recovery-store.js';

export type FinalizationRecoveryApplyOutcome =
  | 'applied'
  | 'already-confirmed'
  | 'deferred';

export interface FinalizationRecoveryLiveInput {
  rawMessage: Uint8Array;
  contextGraphId: string;
  sourcePeerId?: string;
  candidate: ParsedGraphScopedFinalization;
}

export type FinalizationRecoveryLiveProcessResult =
  | { status: 'fallback' }
  | { status: 'handled' }
  | { status: 'retryable-capacity'; ual: string };

export class FinalizationRecoveryCapacityError extends Error {
  readonly code = 'FINALIZATION_RECOVERY_CAPACITY';
  readonly retryable = true;

  constructor(readonly ual: string) {
    super(`Finalization recovery durable capacity exhausted for ${ual}`);
    this.name = 'FinalizationRecoveryCapacityError';
  }
}

type FinalizationRecoveryReceiveOutcome =
  | { status: 'entry'; entry: FinalizationRecoveryEntry }
  | { status: 'pending' }
  | { status: 'capacity' }
  | { status: 'rejected' };

type EnsuredVerifiedReplayEntry =
  | {
      status: 'verified';
      entry: FinalizationRecoveryEntry;
      evidence: VerifiedGraphScopedFinalizationEvidence;
    }
  | { status: 'unverified'; entry: FinalizationRecoveryEntry }
  | { status: 'invalid' };

export type FinalizationRecoveryLiveAdmission =
  | {
    status: 'admitted';
    input: FinalizationRecoveryLiveInput;
    message: ReturnType<typeof decodeFinalizationMessage>;
  }
  | { status: 'invalid' }
  | { status: 'not-graph-scoped' };

export interface FinalizationRecoveryPreparedMaterialization {
  /** Compatibility target used only by the unjournaled legacy verifier. */
  onChainContextGraphId?: string;
  /** Independently resolved identity of the local gossip topic. */
  localTopicOnChainContextGraphId?: string;
  publicQuadsDigest?: string;
  publisherPeerId: string;
  accessPolicy: GraphScopedAccessPolicy;
  allowedPeers: string[];
  workspaceSubGraphName?: string;
}

export type FinalizationMaterializationVerification =
  | {
    status: 'verified';
    blockNumber: number;
    txIndex: number;
    authorAddress?: string;
  }
  | {
    status: 'deferred';
    reason:
      | 'legacy-verification-pending'
      | 'canonical-receipt-pending'
      | 'canonical-receipt-reorged'
      | 'canonical-receipt-rejected'
      | 'canonical-receipt-unsupported'
      | 'context-graph-binding-pending'
      | 'verified-evidence-commit-failed';
  };

interface FinalizationRecoveryLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface FinalizationRecoveryReplayInput {
  chainId: string;
  contextGraphId: string;
  onChainCgId: string;
  ual: string;
  merkleRoot: string;
  kaId: string;
}

export type FinalizationRecoveryReplayOutcome =
  | 'recovered'
  | 'invalidated'
  | 'retry-pending'
  | 'none';

export type FinalizationRecoveryReplayMaterializationOutcome =
  | 'promoted'
  | 'already-confirmed'
  | 'stale-target'
  | 'no-swm'
  | 'verified-vm-metadata-pending'
  | undefined;

export type FinalizationRecoveryInvalidationOutcome =
  | 'invalidated'
  | 'already-absent'
  | 'stale-target'
  | 'deferred';

export interface FinalizationRecoveryMaterializer<
  Prepared extends FinalizationRecoveryPreparedMaterialization,
> {
  prepare(input: FinalizationRecoveryLiveInput): Promise<Prepared | undefined>;
  apply(input: {
    prepared: Prepared;
    blockNumber: number;
    txIndex: number;
    authorAddress?: string;
  }): Promise<FinalizationRecoveryApplyOutcome>;
  replayVerified(input: {
    replay: FinalizationRecoveryReplayInput;
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    evidence: VerifiedGraphScopedFinalizationEvidence;
  }): Promise<FinalizationRecoveryReplayMaterializationOutcome>;
  recoverVerifiedEvidence(input: {
    replay: FinalizationRecoveryReplayInput;
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
  }): Promise<VerifiedGraphScopedFinalizationEvidence | undefined>;
  invalidateVerified(input: {
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    evidence: VerifiedGraphScopedFinalizationEvidence;
    reason: string;
  }): Promise<FinalizationRecoveryInvalidationOutcome>;
  isRetryableError(error: unknown): boolean;
}

export interface FinalizationRecoveryStoreSource {
  getRecoveryStore(): FinalizationRecoveryStore | undefined;
}

type FinalizationVerificationContext =
  | { kind: 'live' }
  | { kind: 'recovery'; entry: FinalizationRecoveryEntry };

export type FinalizationCanonicalReceiptOutcome =
  | { status: 'confirmed'; receipt: CanonicalFinalizationReceipt }
  | { status: 'pending' | 'reorged' | 'rejected' | 'not-found' | 'unsupported' };

interface ResolveCanonicalReceiptOptions {
  acceptCanonicalPlacement?: boolean;
}

const SETTLED_RECEIPT_RETRY_BASE_MS = 1_000;
const SETTLED_RECEIPT_RETRY_MAX_MS = 60_000;
const SETTLED_NOT_FOUND_RETRY_LIMIT = 5;
const DEFERRED_RETRY_BASE_MS = 1_000;
const DEFERRED_RETRY_MAX_MS = 60_000;
/**
 * At the maximum retry delay this is approximately seven days of autonomous
 * worker attempts. The wall-clock window below must also elapse so duplicate
 * gossip and reconciliation cannot burn the budget early.
 */
export const FINALIZATION_RECOVERY_LIVE_RETRY_LIMIT = 7 * 24 * 60;
export const FINALIZATION_RECOVERY_LIVE_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface FinalizationRecoveryOptions {
  liveRetryLimit?: number;
  liveRetryWindowMs?: number;
  now?: () => number;
}

function deferredRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(30, Math.max(0, attemptCount));
  return Math.min(
    DEFERRED_RETRY_MAX_MS,
    DEFERRED_RETRY_BASE_MS * (2 ** exponent),
  );
}

export function finalizationRecoveryEntryKey(input: {
  chainId: string;
  contextGraphId: string;
  ual: string;
  txHash: string;
}): string {
  return `v1|${[
    input.chainId,
    input.contextGraphId,
    input.ual,
    input.txHash.toLowerCase(),
  ].map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|')}`;
}

/** Owns durable inbox transitions and chain-gated replay selection. */
export class FinalizationRecovery<
  Prepared extends FinalizationRecoveryPreparedMaterialization,
> {
  private readonly replaySingleFlights = new Map<
    string,
    Promise<FinalizationRecoveryReplayOutcome>
  >();
  private readonly entryLockTails = new Map<string, Promise<void>>();
  private readonly store: FinalizationRecoveryStore | undefined;
  private readonly storeSource: FinalizationRecoveryStoreSource | undefined;
  private readonly liveRetryLimit: number;
  private readonly liveRetryWindowMs: number;
  private readonly now: () => number;

  constructor(
    store: FinalizationRecoveryStore | FinalizationRecoveryStoreSource | undefined,
    private readonly chain: ChainAdapter | undefined,
    private readonly log: FinalizationRecoveryLog,
    private readonly materializer: FinalizationRecoveryMaterializer<Prepared>,
    options: FinalizationRecoveryOptions = {},
  ) {
    if (store && 'getRecoveryStore' in store) {
      this.storeSource = store;
      this.store = undefined;
    } else {
      this.store = store;
      this.storeSource = undefined;
    }
    this.liveRetryLimit = Math.max(
      1,
      Math.trunc(options.liveRetryLimit ?? FINALIZATION_RECOVERY_LIVE_RETRY_LIMIT),
    );
    this.liveRetryWindowMs = Math.max(
      1,
      Math.trunc(
        options.liveRetryWindowMs ?? FINALIZATION_RECOVERY_LIVE_RETRY_WINDOW_MS,
      ),
    );
    this.now = options.now ?? Date.now;
  }

  private getStore(): FinalizationRecoveryStore | undefined {
    return this.storeSource?.getRecoveryStore() ?? this.store;
  }

  /** Decode and admit graph-scoped wire input before any persistence or RDF work. */
  admitLive(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
  }): FinalizationRecoveryLiveAdmission {
    let message: ReturnType<typeof decodeFinalizationMessage>;
    try {
      message = decodeFinalizationMessage(input.rawMessage);
    } catch {
      return { status: 'not-graph-scoped' };
    }
    if (message.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      return { status: 'not-graph-scoped' };
    }
    const admission = parseGraphScopedFinalization(message, input.contextGraphId);
    if (!admission.ok) {
      this.log.warn(
        `Finalization recovery rejected graph-scoped envelope for `
          + `${message.ual || '(missing UAL)'}: ${admission.reason}`,
      );
      return { status: 'invalid' };
    }
    return {
      status: 'admitted',
      message,
      input: {
        rawMessage: input.rawMessage,
        contextGraphId: input.contextGraphId,
        ...(input.sourcePeerId ? { sourcePeerId: input.sourcePeerId } : {}),
        candidate: admission.value,
      },
    };
  }

  /**
   * Applies a live graph-scoped finalization behind the durable write-ahead
   * boundary. Preserves the original boolean contract for external callers:
   * false means the caller must run the unjournaled compatibility path.
   */
  async processLive(
    input: FinalizationRecoveryLiveInput,
  ): Promise<boolean> {
    const result = await this.processLiveOutcome(input);
    switch (result.status) {
      case 'fallback':
        return false;
      case 'handled':
        return true;
      case 'retryable-capacity':
        throw new FinalizationRecoveryCapacityError(result.ual);
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled finalization recovery result: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Structured result used by internal callers that must distinguish capacity. */
  async processLiveOutcome(
    input: FinalizationRecoveryLiveInput,
  ): Promise<FinalizationRecoveryLiveProcessResult> {
    const store = this.getStore();
    // The receipt API is intentionally optional on ChainAdapter. Preserve the
    // legacy live path when it is absent instead of admitting an envelope that
    // this runtime can never promote to VERIFIED.
    if (
      !store
      || !this.chain
      || this.chain.chainId === 'none'
      || !this.chain.resolveCanonicalFinalizationReceipt
    ) return { status: 'fallback' };
    const key = finalizationRecoveryEntryKey({
      chainId: this.chain.chainId,
      contextGraphId: input.contextGraphId,
      ual: input.candidate.scope.ual,
      txHash: input.candidate.msg.txHash,
    });
    return this.withEntryLock(key, async () => {
      const received = await this.receiveOutcome(input);
      if (received.status === 'pending') {
        await this.recordPendingPublisherAuthority(store, key, input);
        return { status: 'handled' };
      }
      if (received.status === 'capacity') {
        return {
          status: 'retryable-capacity',
          ual: input.candidate.scope.ual,
        };
      }
      // Conflicts, corruption, and write failures fail closed and leave
      // Oxigraph untouched. Capacity is handled separately above because it is
      // retryable and must never look successfully consumed.
      if (received.status === 'rejected') return { status: 'handled' };
      let { entry } = received;
      if (entry.state === 'SETTLED') {
        const revalidated = await this.revalidateSettled(input, entry);
        if (!revalidated) return { status: 'handled' };
        entry = revalidated;
      }
      // Terminal rows remain audited and inert until retention removes them.
      // In particular, duplicate gossip must not revive an entry that exhausted
      // the autonomous retry budget.
      if (!this.isLiveEntry(entry)) return { status: 'handled' };

      // The worker and reconciliation paths already honor this durable gate.
      // Live duplicate gossip must do the same: the per-entry lock serializes
      // equivalent deliveries, but without this check every queued duplicate
      // still repeats the store-heavy workspace-head/materialization probe.
      // A newly inserted row has no deadline and runs immediately; once a
      // deferred attempt records backoff, one due delivery or the autonomous
      // worker may retry it.
      if (!store.isAttemptDue(entry)) return { status: 'handled' };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const outcome = await this.materialize(input, { kind: 'recovery', entry });
          if (outcome === 'deferred') {
            await this.recordDeferred(
              entry,
              'finalization processing deferred',
            );
          } else {
            await this.settleEntry(entry, outcome);
          }
          return { status: 'handled' };
        } catch (error) {
          if (!this.materializer.isRetryableError(error)) throw error;
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            continue;
          }
          this.log.warn(
            `Finalization recovery materialization remained busy for ${entry.ual}; `
              + 'keeping inbox entry',
          );
          await this.recordDeferred(
            entry,
            'store scheduler remained busy',
          );
          return { status: 'handled' };
        }
      }
      return { status: 'handled' };
    });
  }

  private async recordPendingPublisherAuthority(
    store: FinalizationRecoveryStore,
    key: string,
    input: FinalizationRecoveryLiveInput,
  ): Promise<void> {
    if (!input.sourcePeerId) return;
    let prepared: Prepared | undefined;
    try {
      prepared = await this.materializer.prepare(input);
    } catch (error) {
      this.log.info(
        `Finalization recovery deferred publisher authority check for `
          + `${input.candidate.scope.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!prepared || input.sourcePeerId !== prepared.publisherPeerId) return;
    try {
      if (await store.recordPendingTrustedPublisher(key, prepared.publisherPeerId)) return;
      // Promotion is serialized by the store but is intentionally independent
      // of the per-entry recovery lock. If it moved this row between admission
      // and the authority CAS, preserve the same monotonic evidence on the live row.
      const promoted = await store.get(key);
      if (
        promoted
        && this.isLiveEntry(promoted)
        && await store.recordTrustedPublisher(
          key,
          promoted.generation,
          prepared.publisherPeerId,
        )
      ) return;
      this.log.warn(
        `Finalization recovery inbox refused publisher authority for `
          + `${input.candidate.scope.ual}`,
      );
    } catch (error) {
      this.log.warn(
        `Finalization recovery pending publisher authority commit failed for `
          + `${input.candidate.scope.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Replays a bounded due snapshot independently of chain-cursor progress.
   * Entries are processed serially so a recovered backlog cannot recreate the
   * store pressure that caused it.
   */
  async processDueBatch(limit: number): Promise<number> {
    const store = this.getStore();
    if (!store) return 0;
    try {
      if (!this.chain || this.chain.chainId === 'none') return 0;
      let promoted = 0;
      try {
        promoted = await store.promotePending(limit);
      } catch (error) {
        this.log.warn(
          `Finalization recovery deferred-inbox promotion failed: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let entries: FinalizationRecoveryEntry[];
      try {
        entries = await store.listDue(limit);
      } catch (error) {
        this.log.warn(
          `Finalization recovery due-inbox read failed: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
        return 0;
      }
      for (const entry of entries) {
        let outcome: FinalizationRecoveryReplayOutcome;
        try {
          outcome = await this.replayDueEntry(entry);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.log.warn(
            `Finalization recovery due-entry replay failed for ${entry.ual}: ${reason}`,
          );
          await this.recordDeferred(
            entry,
            `background replay failed: ${reason}`,
            deferredRetryDelayMs(entry.attemptCount),
          );
          outcome = 'retry-pending';
        }
        getMetrics().finalizationRecoveryAttemptsTotal?.add(1, { outcome });
      }
      return Math.max(entries.length, promoted);
    } finally {
      await this.recordDueMetrics(store);
    }
  }

  private async recordDueMetrics(store: FinalizationRecoveryStore): Promise<void> {
    try {
      const health = await store.health();
      const metrics = getMetrics();
      metrics.finalizationRecoveryDueEntries?.record(health.dueEntries);
      metrics.finalizationRecoveryOldestDueAgeMs?.record(health.oldestDueAgeMs ?? 0);
      metrics.finalizationRecoveryDeferredEntries?.record(health.deferredEntries ?? 0);
    } catch (error) {
      this.log.warn(
        `Finalization recovery metrics snapshot failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async replayDueEntry(
    snapshot: FinalizationRecoveryEntry,
  ): Promise<FinalizationRecoveryReplayOutcome> {
    return this.withEntryLock(
      snapshot.key,
      () => this.replayDueEntryLocked(snapshot),
    );
  }

  private async replayDueEntryLocked(
    snapshot: FinalizationRecoveryEntry,
  ): Promise<FinalizationRecoveryReplayOutcome> {
    const store = this.getStore();
    if (!store) return 'none';
    const entry = await store.get(snapshot.key);
    if (!entry) return 'none';
    if (!store.isAttemptDue(entry)) return 'retry-pending';
    const liveRetryAgeMs = Math.max(0, this.now() - entry.createdAt);
    if (
      this.isLiveEntry(entry)
      && entry.attemptCount >= this.liveRetryLimit
      && liveRetryAgeMs >= this.liveRetryWindowMs
    ) {
      const reason = 'autonomous retry budget exhausted after '
        + `${entry.attemptCount} attempts over ${liveRetryAgeMs}ms`;
      const rejected = await this.transition(entry, 'REJECTED', reason);
      if (rejected) {
        this.log.warn(
          `Finalization recovery rejected exhausted inbox entry for ${entry.ual}: ${reason}`,
        );
      }
      return 'invalidated';
    }
    if (
      !this.chain
      || this.chain.chainId === 'none'
      || this.chain.chainId !== entry.chainId
      || !this.chain.getKAContextGraphId
    ) {
      await this.recordDeferred(
        entry,
        'background replay lacks the matching chain binding capability',
        deferredRetryDelayMs(entry.attemptCount),
      );
      return 'retry-pending';
    }

    try {
      const boundContextGraphId = await this.chain.getKAContextGraphId(
        BigInt(entry.kaId),
      );
      if (
        boundContextGraphId === null
        || boundContextGraphId === undefined
        || BigInt(boundContextGraphId) <= 0n
      ) {
        await this.recordDeferred(
          entry,
          'background replay chain binding is not available yet',
          deferredRetryDelayMs(entry.attemptCount),
        );
        return 'retry-pending';
      }
      const replayInput: FinalizationRecoveryReplayInput = {
        chainId: entry.chainId,
        contextGraphId: entry.contextGraphId,
        onChainCgId: BigInt(boundContextGraphId).toString(),
        ual: entry.ual,
        merkleRoot: entry.merkleRoot,
        kaId: entry.kaId,
      };
      const matches = await this.matchingEntries(replayInput);
      const matchingEntry = matches.find((candidate) => candidate.key === entry.key);
      const outcome = matchingEntry
        ? await this.replayEntry(
            matchingEntry,
            replayInput,
            deferredRetryDelayMs(matchingEntry.attemptCount),
          )
        : 'none';
      if (outcome !== 'none') return outcome;
      await this.recordDeferred(
        entry,
        'background replay found no canonical finalization match',
        deferredRetryDelayMs(entry.attemptCount),
      );
      return 'retry-pending';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log.warn(
        `Finalization recovery background replay failed for ${entry.ual}: ${reason}`,
      );
      await this.recordDeferred(
        entry,
        `background replay failed: ${reason}`,
        deferredRetryDelayMs(entry.attemptCount),
      );
      return 'retry-pending';
    }
  }

  private isLiveEntry(entry: FinalizationRecoveryEntry): boolean {
    return entry.state === 'RECEIVED'
      || entry.state === 'VERIFIED'
      || entry.state === 'REORGED';
  }

  private async withEntryLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.entryLockTails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.entryLockTails.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.entryLockTails.get(key) === current) {
        this.entryLockTails.delete(key);
      }
    }
  }

  /** Processes the compatibility path when no durable inbox can be used. */
  processUnjournaled(
    input: FinalizationRecoveryLiveInput,
  ): Promise<FinalizationRecoveryApplyOutcome> {
    return this.materialize(input, { kind: 'live' });
  }

  async receive(
    input: FinalizationRecoveryLiveInput,
  ): Promise<FinalizationRecoveryEntry | undefined> {
    const outcome = await this.receiveOutcome(input);
    return outcome.status === 'entry' ? outcome.entry : undefined;
  }

  private async receiveOutcome(
    input: FinalizationRecoveryLiveInput,
  ): Promise<FinalizationRecoveryReceiveOutcome> {
    const store = this.getStore();
    if (!store) return { status: 'rejected' };
    const { candidate } = input;
    const key = finalizationRecoveryEntryKey({
      chainId: this.chain?.chainId ?? 'none',
      contextGraphId: input.contextGraphId,
      ual: candidate.scope.ual,
      txHash: candidate.msg.txHash,
    });
    try {
      const result = await store.receive({
        key,
        chainId: this.chain?.chainId ?? 'none',
        contextGraphId: input.contextGraphId,
        ...(input.sourcePeerId ? { sourcePeerId: input.sourcePeerId } : {}),
        ual: candidate.scope.ual,
        txHash: candidate.msg.txHash,
        assertionVersion: candidate.assertionVersion,
        merkleRoot: ethers.hexlify(candidate.msg.kcMerkleRoot),
        kaId: candidate.kaId.toString(),
        batchId: candidate.batchId.toString(),
        ...(candidate.msg.targetContextGraphId
          ? { targetContextGraphId: candidate.msg.targetContextGraphId }
          : {}),
        rawMessage: input.rawMessage,
      });
      if (
        result.status === 'inserted'
        || result.status === 'existing'
      ) {
        if (
          (result.entry.state === 'REORGED' || result.entry.state === 'SETTLED')
          && !this.matchesImmutableStoredEnvelope(input, result.entry)
        ) {
          this.log.warn(
            `Finalization recovery inbox rejected changed immutable envelope for `
              + `${candidate.scope.ual}`,
          );
          getMetrics().finalizationRecoveryAdmissionTotal?.add(1, { outcome: 'conflict' });
          return { status: 'rejected' };
        }
        if (
          result.entry.state === 'RECEIVED'
          || result.entry.state === 'VERIFIED'
          || result.entry.state === 'REORGED'
          || result.entry.state === 'SETTLED'
        ) {
          getMetrics().finalizationRecoveryAdmissionTotal?.add(1, {
            outcome: result.status,
          });
          return { status: 'entry', entry: result.entry };
        }
        getMetrics().finalizationRecoveryAdmissionTotal?.add(1, { outcome: 'conflict' });
        return { status: 'rejected' };
      }
      if (result.status === 'pending') {
        getMetrics().finalizationRecoveryAdmissionTotal?.add(1, { outcome: 'deferred' });
        this.log.info(
          `Finalization recovery deferred ${candidate.scope.ual} until live inbox capacity is available`,
        );
        return { status: 'pending' };
      }
      this.log.warn(
        `Finalization recovery inbox rejected ${candidate.scope.ual}: ${result.status}`,
      );
      getMetrics().finalizationRecoveryAdmissionTotal?.add(1, {
        outcome: result.status,
      });
      return result.status === 'capacity'
        ? { status: 'capacity' }
        : { status: 'rejected' };
    } catch (error) {
      this.log.warn(
        `Finalization recovery inbox write failed for ${candidate.scope.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      getMetrics().finalizationRecoveryAdmissionTotal?.add(1, { outcome: 'write-failure' });
      return { status: 'rejected' };
    }
  }

  async resolveCanonicalReceipt(
    candidate: ParsedGraphScopedFinalization,
    persisted?: VerifiedGraphScopedFinalizationEvidence,
    options: ResolveCanonicalReceiptOptions = {},
  ): Promise<FinalizationCanonicalReceiptOutcome> {
    const resolver = this.chain?.resolveCanonicalFinalizationReceipt;
    if (!this.chain || this.chain.chainId === 'none' || !resolver) {
      return { status: 'unsupported' };
    }
    let resolution: CanonicalFinalizationReceiptResolution;
    try {
      resolution = await resolver.call(
        this.chain,
        candidate.msg.txHash,
        persisted
          ? {
            expectedBlockHash: persisted.blockHash,
            expectedBlockNumber: persisted.blockNumber,
          }
          : {},
      );
    } catch (error) {
      this.log.info(
        `Finalization recovery canonical receipt is pending for ${candidate.scope.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'pending' };
    }
    if (resolution.status !== 'confirmed') return resolution;
    const { receipt } = resolution;
    if (
      receipt.txHash.toLowerCase() !== candidate.msg.txHash.toLowerCase()
      || !equalBytes(receipt.merkleRoot, candidate.msg.kcMerkleRoot)
      || receipt.publisherAddress.toLowerCase() !== candidate.msg.publisherAddress.toLowerCase()
      || receipt.batchId !== candidate.batchId
      || receipt.kaId !== candidate.kaId
      || receipt.startKAId !== candidate.startKAId
      || receipt.endKAId !== candidate.endKAId
      || !Number.isSafeInteger(receipt.blockNumber)
      || receipt.blockNumber < 0
      || !Number.isSafeInteger(receipt.txIndex)
      || receipt.txIndex < 0
      || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)
    ) {
      return { status: 'rejected' };
    }
    if (
      !options.acceptCanonicalPlacement
      && receipt.blockNumber !== candidate.blockNumber
    ) return { status: 'reorged' };
    return { status: 'confirmed', receipt };
  }

  /** Produces and durably commits the chain evidence required by materialization. */
  private async verifyMaterialization(
    candidate: ParsedGraphScopedFinalization,
    context: FinalizationVerificationContext,
    prepared: Prepared,
  ): Promise<FinalizationMaterializationVerification> {
    if (context.kind === 'live') {
      const legacy = await this.verifyLegacy(candidate, prepared.onChainContextGraphId);
      if (!legacy.verified) {
        return { status: 'deferred', reason: 'legacy-verification-pending' };
      }
      const txIndex = legacy.txIndex ?? 0;
      if (!Number.isSafeInteger(txIndex) || txIndex < 0) {
        return { status: 'deferred', reason: 'legacy-verification-pending' };
      }
      return {
        status: 'verified',
        blockNumber: candidate.blockNumber,
        txIndex,
        ...(legacy.authorAddress ? { authorAddress: legacy.authorAddress } : {}),
      };
    }

    const { entry } = context;
    const canonical = await this.resolveCanonicalReceipt(
      candidate,
      entry.verifiedEvidence,
      { acceptCanonicalPlacement: entry.state === 'REORGED' },
    );
    if (canonical.status === 'unsupported') {
      await this.markUnsupported(entry);
      this.log.warn(
        `Finalization recovery canonical receipt is unsupported for ${entry.ual}`,
      );
      return { status: 'deferred', reason: 'canonical-receipt-unsupported' };
    }
    if (canonical.status === 'reorged') {
      await this.markReorged(entry, 'canonical receipt mismatch or reorg');
      this.log.warn(
        `Finalization recovery canonical receipt is reorged for ${entry.ual}`,
      );
      return { status: 'deferred', reason: 'canonical-receipt-reorged' };
    }
    if (canonical.status === 'rejected') {
      await this.rejectEntry(
        entry,
        'transaction failed or contains no finalization event',
      );
      this.log.warn(
        `Finalization recovery canonical receipt is rejected for ${entry.ual}`,
      );
      return { status: 'deferred', reason: 'canonical-receipt-rejected' };
    }
    if (canonical.status !== 'confirmed') {
      this.log.info(
        `Finalization recovery canonical receipt is ${canonical.status} for ${entry.ual}`,
      );
      return { status: 'deferred', reason: 'canonical-receipt-pending' };
    }
    if (!await this.verifyContextGraphBinding(candidate, prepared)) {
      this.log.info(
        `Finalization recovery context-graph binding is pending for ${entry.ual}`,
      );
      return { status: 'deferred', reason: 'context-graph-binding-pending' };
    }

    const evidence = VerifiedGraphScopedFinalizationEvidenceCodec.build({
      candidate,
      ...(prepared.publicQuadsDigest
        ? { publicQuadsDigest: prepared.publicQuadsDigest }
        : {}),
      publisherPeerId: prepared.publisherPeerId,
      blockNumber: canonical.receipt.blockNumber,
      blockHash: canonical.receipt.blockHash,
      txIndex: canonical.receipt.txIndex,
      ...(canonical.receipt.authorAddress
        ? { authorAddress: canonical.receipt.authorAddress }
        : {}),
      accessPolicy: prepared.accessPolicy,
      allowedPeers: prepared.allowedPeers,
      workspaceSubGraphName: prepared.workspaceSubGraphName,
    });
    const committed = await this.recordVerified(entry, evidence);
    if (!committed) {
      return { status: 'deferred', reason: 'verified-evidence-commit-failed' };
    }
    return {
      status: 'verified',
      blockNumber: canonical.receipt.blockNumber,
      txIndex: canonical.receipt.txIndex,
      ...(canonical.receipt.authorAddress
        ? { authorAddress: canonical.receipt.authorAddress }
        : {}),
    };
  }

  private async materialize(
    input: FinalizationRecoveryLiveInput,
    context: FinalizationVerificationContext,
  ): Promise<FinalizationRecoveryApplyOutcome> {
    const preparationInput = context.kind === 'recovery'
      && context.entry.trustedPublisherPeerId
      ? {
          ...input,
          sourcePeerId: context.entry.trustedPublisherPeerId,
        }
      : input;
    const prepared = await this.materializer.prepare(preparationInput);
    if (!prepared) return 'deferred';
    if (
      context.kind === 'recovery'
      && input.sourcePeerId !== undefined
      && input.sourcePeerId === prepared.publisherPeerId
      && !await this.recordTrustedPublisher(context.entry, prepared.publisherPeerId)
    ) return 'deferred';
    const verification = await this.verifyMaterialization(
      input.candidate,
      context,
      prepared,
    );
    if (verification.status === 'deferred') {
      this.log.info(
        `Finalization verification deferred for ${input.candidate.scope.ual} `
          + `(${verification.reason})`,
      );
      return 'deferred';
    }
    return this.materializer.apply({
      prepared,
      blockNumber: verification.blockNumber,
      txIndex: verification.txIndex,
      ...(verification.authorAddress
        ? { authorAddress: verification.authorAddress }
        : {}),
    });
  }

  private async recordTrustedPublisher(
    entry: FinalizationRecoveryEntry,
    publisherPeerId: string,
  ): Promise<boolean> {
    const store = this.getStore();
    if (!store) return false;
    try {
      const recorded = await store.recordTrustedPublisher(
        entry.key,
        entry.generation,
        publisherPeerId,
      );
      if (recorded) return true;
      this.log.warn(
        `Finalization recovery inbox refused trusted publisher observation for ${entry.ual}`,
      );
    } catch (error) {
      this.log.warn(
        `Finalization recovery trusted publisher commit failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }

  async recordVerified(
    entry: FinalizationRecoveryEntry,
    evidence: VerifiedGraphScopedFinalizationEvidence,
  ): Promise<FinalizationRecoveryEntry | undefined> {
    const store = this.getStore();
    if (!store) return undefined;
    try {
      const result = await store.markVerified(entry.key, entry.generation, evidence);
      if (result.status === 'verified' || result.status === 'existing') return result.entry;
      this.log.warn(
        `Finalization recovery inbox refused VERIFIED for ${entry.ual}: ${result.status}`,
      );
    } catch (error) {
      this.log.warn(
        `Finalization recovery VERIFIED commit failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }

  async settleEntry(
    entry: FinalizationRecoveryEntry,
    outcome: FinalizationRecoveryApplyOutcome,
  ): Promise<boolean> {
    if (!this.getStore() || outcome === 'deferred') return false;
    return this.transition(entry, 'SETTLED');
  }

  async recordDeferred(
    entry: FinalizationRecoveryEntry,
    reason: string,
    retryDelayMs?: number,
  ): Promise<void> {
    const store = this.getStore();
    if (!store) return;
    try {
      await store.recordAttempt(
        entry.key,
        entry.generation,
        reason,
        retryDelayMs,
      );
    } catch (error) {
      this.log.warn(
        `Finalization recovery attempt update failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async rejectEntry(entry: FinalizationRecoveryEntry, reason: string): Promise<boolean> {
    return this.transition(entry, 'REJECTED', reason);
  }

  async markReorged(entry: FinalizationRecoveryEntry, reason: string): Promise<boolean> {
    const store = this.getStore();
    if (!store) return false;
    try {
      return await store.markReorged(entry.key, entry.generation, reason);
    } catch (error) {
      this.log.warn(
        `Finalization recovery reorg transition failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async revalidateSettled(
    input: FinalizationRecoveryLiveInput,
    entry: FinalizationRecoveryEntry,
  ): Promise<FinalizationRecoveryEntry | undefined> {
    const evidence = entry.verifiedEvidence;
    if (
      !evidence
      || !VerifiedGraphScopedFinalizationEvidenceCodec.matchesImmutableEnvelope(
        evidence,
        input.candidate,
        entry,
      )
    ) {
      this.log.warn(
        `Finalization recovery settled evidence does not match replacement envelope for `
          + `${entry.ual}`,
      );
      return undefined;
    }
    let publisherUpgradePeerId = entry.publisherUpgradePending
      ? entry.trustedPublisherPeerId
      : undefined;
    let publisherUpgradeNewlyRecorded = false;
    const store = this.getStore();
    const attemptDue = store?.isAttemptDue(entry) ?? false;
    const mayIntroducePublisherAuthority = !entry.publisherUpgradePending
      && entry.trustedPublisherPeerId === undefined
      && input.sourcePeerId !== undefined
      && input.sourcePeerId === evidence.publisherPeerId;
    // A relay or an already recorded publisher cannot add authority. Keep the
    // persisted retry gate ahead of the store-heavy workspace-head probe.
    if (!attemptDue && !mayIntroducePublisherAuthority) return undefined;
    if (!publisherUpgradePeerId) {
      const publisherAuthority = await this.prepareSettledPublisherUpgrade(input, evidence);
      if (publisherAuthority.status === 'deferred') return undefined;
      if (publisherAuthority.status === 'upgrade') {
        const recorded = await this.recordSettledPublisherUpgrade(
          entry,
          publisherAuthority.prepared.publisherPeerId,
        );
        if (!recorded) return undefined;
        entry = recorded.entry;
        publisherUpgradePeerId = publisherAuthority.prepared.publisherPeerId;
        publisherUpgradeNewlyRecorded = recorded.status === 'recorded';
      }
    }
    // The first durable authority observation wakes one receipt probe. Once
    // pending, duplicates must obey the settled row's persisted retry deadline.
    if (!publisherUpgradeNewlyRecorded && !attemptDue) return undefined;
    const canonical = await this.resolveCanonicalReceipt(
      input.candidate,
      evidence,
      { acceptCanonicalPlacement: entry.generation > 0 },
    );
    if (canonical.status === 'rejected') {
      await this.invalidateSettled(
        entry,
        input.candidate,
        evidence,
        'canonical receipt permanently rejected',
      );
      return undefined;
    }
    if (canonical.status === 'pending' || canonical.status === 'not-found') {
      if (
        canonical.status === 'not-found'
        && entry.attemptCount + 1 >= SETTLED_NOT_FOUND_RETRY_LIMIT
      ) {
        await this.invalidateSettled(
          entry,
          input.candidate,
          evidence,
          'canonical receipt disappeared after bounded retries',
        );
      } else {
        await this.recordSettledRetry(
          entry,
          `settled canonical receipt is ${canonical.status}`,
        );
      }
      return undefined;
    }
    const placementChanged = canonical.status === 'reorged'
      || (
        canonical.status === 'confirmed'
        && !sameCanonicalFinalizationPlacement(canonical.receipt, evidence)
    );
    if (!placementChanged) {
      if (canonical.status === 'confirmed') {
        if (publisherUpgradePeerId) {
          if (!await this.validatePersistedSettledPublisherUpgrade(
            entry,
            input.candidate,
            publisherUpgradePeerId,
          )) return undefined;
          return this.rearmSettledWithTrustedPublisher(
            input,
            entry,
            publisherUpgradePeerId,
            'trusted publisher access semantics arrived after settlement',
          );
        }
        await this.clearSettledRetry(entry);
      } else {
        this.log.info(
          `Finalization recovery settled receipt is ${canonical.status} for ${entry.ual}; `
            + 'retaining prior materialization',
        );
      }
      return undefined;
    }
    if (publisherUpgradePeerId) {
      if (!await this.validatePersistedSettledPublisherUpgrade(
        entry,
        input.candidate,
        publisherUpgradePeerId,
      )) return undefined;
      return this.rearmSettledWithTrustedPublisher(
        input,
        entry,
        publisherUpgradePeerId,
        'trusted publisher access semantics and canonical placement changed after settlement',
      );
    }
    if (!await this.markReorged(
      entry,
      'settled receipt disagrees with canonical chain truth',
    )) {
      this.log.warn(
        `Finalization recovery could not rearm settled receipt for ${entry.ual}`,
      );
      return undefined;
    }
    return this.receive(input);
  }

  private async prepareSettledPublisherUpgrade(
    input: FinalizationRecoveryLiveInput,
    evidence: VerifiedGraphScopedFinalizationEvidence,
  ): Promise<
    | { status: 'upgrade'; prepared: Prepared }
    | { status: 'none' | 'deferred' }
  > {
    if (!input.sourcePeerId) return { status: 'none' };
    let prepared: Prepared | undefined;
    try {
      prepared = await this.materializer.prepare(input);
    } catch (error) {
      if (!this.materializer.isRetryableError(error)) throw error;
      this.log.info(
        `Finalization recovery publisher authority check is deferred for `
          + `${input.candidate.scope.ual}`,
      );
      return { status: 'deferred' };
    }
    if (
      !prepared
      || input.sourcePeerId !== prepared.publisherPeerId
      || sameGraphScopedAccessSemantics(prepared, evidence)
    ) return { status: 'none' };
    return { status: 'upgrade', prepared };
  }

  private async recordSettledPublisherUpgrade(
    entry: FinalizationRecoveryEntry,
    publisherPeerId: string,
  ): Promise<
    Extract<
      FinalizationRecoverySettledPublisherUpgradeResult,
      { status: 'recorded' | 'existing' }
    > | undefined
  > {
    const store = this.getStore();
    if (!store) return undefined;
    try {
      const result = await store.recordSettledPublisherUpgrade(
        entry.key,
        entry.generation,
        publisherPeerId,
      );
      if (result.status === 'recorded' || result.status === 'existing') return result;
      this.log.warn(
        `Finalization recovery inbox refused pending publisher upgrade for `
          + `${entry.ual}: ${result.status}`,
      );
    } catch (error) {
      this.log.warn(
        `Finalization recovery pending publisher upgrade commit failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }

  private async validatePersistedSettledPublisherUpgrade(
    entry: FinalizationRecoveryEntry,
    candidate: ParsedGraphScopedFinalization,
    publisherPeerId: string,
  ): Promise<boolean> {
    try {
      const prepared = await this.materializer.prepare({
        rawMessage: entry.rawMessage,
        contextGraphId: entry.contextGraphId,
        sourcePeerId: publisherPeerId,
        candidate,
      });
      if (prepared?.publisherPeerId === publisherPeerId) return true;
    } catch (error) {
      if (!this.materializer.isRetryableError(error)) throw error;
    }
    this.log.info(
      `Finalization recovery persisted publisher authority check is deferred for `
        + `${entry.ual}`,
    );
    await this.recordSettledRetry(
      entry,
      'persisted publisher authority validation is deferred',
    );
    return false;
  }

  private async rearmSettledWithTrustedPublisher(
    input: FinalizationRecoveryLiveInput,
    entry: FinalizationRecoveryEntry,
    publisherPeerId: string,
    reason: string,
  ): Promise<FinalizationRecoveryEntry | undefined> {
    const store = this.getStore();
    if (!store) return undefined;
    try {
      await store.rearmSettledWithTrustedPublisher(
        entry.key,
        entry.generation,
        publisherPeerId,
        reason,
      );
      // Reload even after a lost compare-and-set: another identical delivery
      // may already have performed the same rearm.
      const rearmed = await this.receive(input);
      if (
        rearmed?.state === 'REORGED'
        && rearmed.generation === entry.generation + 1
        && rearmed.trustedPublisherPeerId === publisherPeerId
        && rearmed.publisherUpgradePending
      ) return rearmed;
      this.log.warn(
        `Finalization recovery inbox refused trusted publisher rearm for ${entry.ual}`,
      );
    } catch (error) {
      this.log.warn(
        `Finalization recovery trusted publisher rearm failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }

  private async clearSettledRetry(entry: FinalizationRecoveryEntry): Promise<void> {
    const store = this.getStore();
    if (!store || (entry.attemptCount === 0 && entry.nextAttemptAt === undefined)) return;
    try {
      await store.clearSettledRetry(entry.key, entry.generation);
    } catch (error) {
      this.log.warn(
        `Finalization recovery settled retry reset failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async recordSettledRetry(
    entry: FinalizationRecoveryEntry,
    reason: string,
  ): Promise<void> {
    const store = this.getStore();
    if (!store) return;
    const exponent = Math.min(entry.attemptCount, 16);
    const delayMs = Math.min(
      SETTLED_RECEIPT_RETRY_BASE_MS * (2 ** exponent),
      SETTLED_RECEIPT_RETRY_MAX_MS,
    );
    try {
      await store.recordAttempt(
        entry.key,
        entry.generation,
        reason,
        delayMs,
      );
    } catch (error) {
      this.log.warn(
        `Finalization recovery settled retry update failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async invalidateSettled(
    entry: FinalizationRecoveryEntry,
    candidate: ParsedGraphScopedFinalization,
    evidence: VerifiedGraphScopedFinalizationEvidence,
    reason: string,
  ): Promise<boolean> {
    const store = this.getStore();
    if (!store) return false;
    const outcome = await this.materializer.invalidateVerified({
      entry,
      candidate,
      evidence,
      reason,
    });
    if (outcome === 'deferred') {
      await this.recordSettledRetry(entry, 'settled canonical invalidation is deferred');
      return false;
    }
    try {
      return await store.rejectSettled(entry.key, entry.generation, reason);
    } catch (error) {
      this.log.warn(
        `Finalization recovery settled rejection failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async markUnsupported(entry: FinalizationRecoveryEntry): Promise<boolean> {
    return this.transition(
      entry,
      'UNSUPPORTED',
      'chain adapter lacks canonical finalization receipt capability',
    );
  }

  async matchingEntries(input: FinalizationRecoveryReplayInput): Promise<FinalizationRecoveryEntry[]> {
    const store = this.getStore();
    if (!store) return [];
    if (
      !this.chain?.getLatestMerkleRoot
      || !this.chain.getMerkleRootCount
      || !this.chain.getKAContextGraphId
    ) return [];

    let entries: FinalizationRecoveryEntry[];
    try {
      entries = await store.listForKnowledgeAsset(input);
    } catch (error) {
      this.log.warn(
        `Finalization recovery inbox read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    const settled = entries.filter((entry) =>
      entry.state === 'SETTLED'
      && (
        entry.targetContextGraphId === undefined
        || entry.targetContextGraphId === input.onChainCgId
      ));
    const recoverable = entries.filter((entry) => entry.state !== 'SETTLED');
    if (recoverable.length === 0) return settled;

    let latestRoot: Uint8Array;
    let rootCount: bigint;
    let boundContextGraphId: bigint | null | undefined;
    try {
      [latestRoot, rootCount, boundContextGraphId] = await Promise.all([
        this.chain.getLatestMerkleRoot(BigInt(input.kaId)),
        this.chain.getMerkleRootCount(BigInt(input.kaId)),
        this.chain.getKAContextGraphId(BigInt(input.kaId)),
      ]);
    } catch (error) {
      this.log.info(
        `Finalization recovery chain state is not settled for ${input.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return settled;
    }

    const matches: FinalizationRecoveryEntry[] = [];
    const superseded: FinalizationRecoveryEntry[] = [];
    for (const entry of recoverable) {
      if (
        entry.targetContextGraphId !== undefined
        && entry.targetContextGraphId !== input.onChainCgId
      ) continue;
      try {
        const assertionVersion = BigInt(entry.assertionVersion);
        if (rootCount > assertionVersion) {
          superseded.push(entry);
          continue;
        }
        if (
          !equalBytes(latestRoot, ethers.getBytes(entry.merkleRoot))
          || !equalBytes(latestRoot, ethers.getBytes(input.merkleRoot))
          || rootCount !== assertionVersion
          || boundContextGraphId === null
          || boundContextGraphId === undefined
          || BigInt(boundContextGraphId).toString() !== input.onChainCgId
        ) continue;
        matches.push(entry);
      } catch (error) {
        this.log.info(
          `Finalization recovery entry is not comparable for ${entry.ual}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await Promise.all(superseded.map(async (entry) => {
      await this.transition(
        entry,
        'SUPERSEDED',
        `canonical assertion version advanced to ${rootCount}`,
      );
      this.log.info(
        `Finalization recovery superseded assertion ${entry.assertionVersion} for ${entry.ual}`,
      );
    }));
    return [...settled, ...matches];
  }

  async replayMatching(
    input: FinalizationRecoveryReplayInput,
    options: { persistDeferredBackoff?: boolean } = {},
  ): Promise<FinalizationRecoveryReplayOutcome> {
    const entries = await this.matchingEntries(input);
    let outcome: FinalizationRecoveryReplayOutcome = 'none';
    for (const entry of entries) {
      const replayKey = this.replaySingleFlightKey(entry, input);
      const existing = this.replaySingleFlights.get(replayKey);
      const replay = existing ?? this.withEntryLock(
        entry.key,
        () => this.replayEntry(
          entry,
          input,
          options.persistDeferredBackoff
            ? deferredRetryDelayMs(entry.attemptCount)
            : undefined,
        ),
      ).finally(() => {
        if (this.replaySingleFlights.get(replayKey) === replay) {
          this.replaySingleFlights.delete(replayKey);
        }
      });
      if (!existing) this.replaySingleFlights.set(replayKey, replay);
      const entryOutcome = await replay;
      if (entryOutcome === 'recovered') outcome = 'recovered';
      else if (entryOutcome === 'retry-pending' && outcome !== 'recovered') {
        outcome = 'retry-pending';
      } else if (entryOutcome === 'invalidated' && outcome === 'none') {
        outcome = 'invalidated';
      }
    }
    return outcome;
  }

  private replaySingleFlightKey(
    entry: FinalizationRecoveryEntry,
    input: FinalizationRecoveryReplayInput,
  ): string {
    return JSON.stringify([
      entry.key,
      input.chainId,
      input.contextGraphId,
      input.onChainCgId,
      input.ual,
      input.merkleRoot.toLowerCase(),
      input.kaId,
    ]);
  }

  async health(): Promise<FinalizationRecoveryHealth> {
    const store = this.getStore();
    if (!store) {
      return {
        available: false,
        closed: false,
        degradedReason: 'not-configured',
        stateCounts: {},
        livePayloadBytes: 0,
        dueEntries: 0,
      };
    }
    return store.health();
  }

  private async transition(
    entry: FinalizationRecoveryEntry,
    state: 'SETTLED' | 'SUPERSEDED' | 'REJECTED' | 'UNSUPPORTED',
    reason?: string,
  ): Promise<boolean> {
    const store = this.getStore();
    if (!store) return false;
    try {
      return await store.transition(entry.key, entry.generation, state, reason);
    } catch (error) {
      this.log.warn(
        `Finalization recovery transition to ${state} failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async replaySettled(
    entry: FinalizationRecoveryEntry,
    candidate: ParsedGraphScopedFinalization,
    input: FinalizationRecoveryReplayInput,
    deferredRetryDelay?: number,
  ): Promise<FinalizationRecoveryReplayOutcome> {
    const evidence = entry.verifiedEvidence;
    if (
      !evidence
      || !VerifiedGraphScopedFinalizationEvidenceCodec.matchesImmutableEnvelope(
        evidence,
        candidate,
        entry,
      )
    ) {
      this.log.warn(
        `Finalization recovery settled evidence does not match its envelope for ${entry.ual}`,
      );
      return 'none';
    }

    const matchesReplayTarget = await this.settledMatchesReplayTarget(entry, input);
    if (!this.getStore()?.isAttemptDue(entry)) {
      return matchesReplayTarget ? 'retry-pending' : 'none';
    }
    const canonical = await this.resolveCanonicalReceipt(
      candidate,
      evidence,
      { acceptCanonicalPlacement: entry.generation > 0 },
    );
    if (canonical.status === 'confirmed') {
      if (entry.publisherUpgradePending) {
        const recovered = await this.recoverSettledPublisherUpgrade(
          entry,
          candidate,
          sameCanonicalFinalizationPlacement(canonical.receipt, evidence)
            ? 'trusted publisher access semantics arrived after settlement'
            : 'trusted publisher access semantics and canonical placement changed after settlement',
          deferredRetryDelay,
        );
        if (!matchesReplayTarget) return 'none';
        return recovered ? 'recovered' : 'retry-pending';
      }
      if (!sameCanonicalFinalizationPlacement(canonical.receipt, evidence)) {
        const recovered = await this.recoverSettledReorg(
          entry,
          candidate,
          deferredRetryDelay,
        );
        if (!matchesReplayTarget) return 'none';
        return recovered ? 'recovered' : 'retry-pending';
      }
      await this.clearSettledRetry(entry);
      if (!matchesReplayTarget) return 'none';
      const replayOutcome = await this.materializer.replayVerified({
        replay: input,
        entry,
        candidate,
        evidence,
      });
      return replayOutcome === 'promoted'
        || replayOutcome === 'already-confirmed'
        || replayOutcome === 'stale-target'
        ? 'recovered'
        : 'none';
    }
    if (canonical.status === 'reorged') {
      if (entry.publisherUpgradePending) {
        const recovered = await this.recoverSettledPublisherUpgrade(
          entry,
          candidate,
          'trusted publisher access semantics and canonical placement changed after settlement',
          deferredRetryDelay,
        );
        if (!matchesReplayTarget) return 'none';
        return recovered ? 'recovered' : 'retry-pending';
      }
      const recovered = await this.recoverSettledReorg(
        entry,
        candidate,
        deferredRetryDelay,
      );
      if (!matchesReplayTarget) return 'none';
      return recovered ? 'recovered' : 'retry-pending';
    }
    if (canonical.status === 'rejected') {
      const invalidated = await this.invalidateSettled(
        entry,
        candidate,
        evidence,
        'canonical receipt permanently rejected',
      );
      if (!matchesReplayTarget) return 'none';
      return invalidated ? 'invalidated' : 'retry-pending';
    }
    if (canonical.status === 'not-found') {
      if (entry.attemptCount + 1 >= SETTLED_NOT_FOUND_RETRY_LIMIT) {
        const invalidated = await this.invalidateSettled(
          entry,
          candidate,
          evidence,
          'canonical receipt disappeared after bounded retries',
        );
        if (!matchesReplayTarget) return 'none';
        return invalidated ? 'invalidated' : 'retry-pending';
      }
      await this.recordSettledRetry(
        entry,
        `settled canonical receipt is ${canonical.status}`,
      );
      return matchesReplayTarget ? 'retry-pending' : 'none';
    }
    if (canonical.status === 'pending' || canonical.status === 'unsupported') {
      await this.recordSettledRetry(
        entry,
        `settled canonical receipt is ${canonical.status}`,
      );
      return matchesReplayTarget ? 'retry-pending' : 'none';
    }
    return 'none';
  }

  private async recoverSettledPublisherUpgrade(
    entry: FinalizationRecoveryEntry,
    candidate: ParsedGraphScopedFinalization,
    reason: string,
    deferredRetryDelay?: number,
  ): Promise<boolean> {
    const publisherPeerId = entry.trustedPublisherPeerId;
    if (
      !publisherPeerId
      || !await this.validatePersistedSettledPublisherUpgrade(
        entry,
        candidate,
        publisherPeerId,
      )
    ) return false;
    const recoveryInput: FinalizationRecoveryLiveInput = {
      rawMessage: entry.rawMessage,
      contextGraphId: entry.contextGraphId,
      sourcePeerId: publisherPeerId,
      candidate,
    };
    const rearmed = await this.rearmSettledWithTrustedPublisher(
      recoveryInput,
      entry,
      publisherPeerId,
      reason,
    );
    if (!rearmed) return false;
    const outcome = await this.materialize(
      recoveryInput,
      { kind: 'recovery', entry: rearmed },
    );
    if (outcome === 'deferred') {
      await this.recordDeferred(
        rearmed,
        'settled publisher upgrade recovery deferred',
        deferredRetryDelay,
      );
      return false;
    }
    return this.settleEntry(rearmed, outcome);
  }

  private async settledMatchesReplayTarget(
    entry: FinalizationRecoveryEntry,
    input: FinalizationRecoveryReplayInput,
  ): Promise<boolean> {
    try {
      if (!equalBytes(
        ethers.getBytes(entry.merkleRoot),
        ethers.getBytes(input.merkleRoot),
      )) return false;
      if (!this.chain?.getMerkleRootCount) return false;
      const rootCount = await this.chain.getMerkleRootCount(BigInt(input.kaId));
      return rootCount === BigInt(entry.assertionVersion);
    } catch (error) {
      this.log.info(
        `Finalization recovery could not compare settled assertion version for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async recoverSettledReorg(
    entry: FinalizationRecoveryEntry,
    candidate: ParsedGraphScopedFinalization,
    deferredRetryDelay?: number,
  ): Promise<boolean> {
    if (!await this.markReorged(
      entry,
      'settled receipt disagrees with canonical chain truth',
    )) return false;
    const recoverySourcePeerId = entry.trustedPublisherPeerId ?? entry.sourcePeerId;
    const reorged = await this.receive({
      rawMessage: entry.rawMessage,
      contextGraphId: entry.contextGraphId,
      ...(recoverySourcePeerId ? { sourcePeerId: recoverySourcePeerId } : {}),
      candidate,
    });
    if (!reorged || reorged.state !== 'REORGED') return false;
    const outcome = await this.materialize(
      {
        rawMessage: entry.rawMessage,
        contextGraphId: entry.contextGraphId,
        ...(recoverySourcePeerId ? { sourcePeerId: recoverySourcePeerId } : {}),
        candidate,
      },
      { kind: 'recovery', entry: reorged },
    );
    if (outcome === 'deferred') {
      await this.recordDeferred(
        reorged,
        'settled reorg recovery deferred',
        deferredRetryDelay,
      );
      return false;
    }
    return this.settleEntry(reorged, outcome);
  }

  private async replayEntry(
    snapshot: FinalizationRecoveryEntry,
    input: FinalizationRecoveryReplayInput,
    deferredRetryDelay?: number,
  ): Promise<FinalizationRecoveryReplayOutcome> {
    const store = this.getStore();
    if (!store) return 'none';
    const entry = await store.get(snapshot.key);
    if (!entry || (!this.isLiveEntry(entry) && entry.state !== 'SETTLED')) {
      return 'none';
    }
    try {
      // Only autonomous replay observes its persisted deadline. Chain
      // reconciliation remains an immediate, authoritative recovery trigger.
      if (
        deferredRetryDelay !== undefined
        && entry.state !== 'SETTLED'
        && !store.isAttemptDue(entry)
      ) return 'retry-pending' as const;
      const candidate = this.decodeEntry(entry);
      if (!candidate) return 'none' as const;
      if (entry.state === 'SETTLED') {
        return this.replaySettled(
          entry,
          candidate,
          input,
          deferredRetryDelay,
        );
      }

      const ensured = await this.ensureVerifiedReplayEntry(entry, candidate, input);
      if (ensured.status === 'invalid') return 'none' as const;
      const replayEntry = ensured.entry;

      let outcome: FinalizationRecoveryApplyOutcome;
      if (ensured.status === 'verified') {
        const { evidence } = ensured;
        const receiptStatus = await this.verifyPersistedReceipt(
          candidate,
          evidence,
          replayEntry.generation > 0,
        );
        if (receiptStatus !== 'confirmed') {
          if (receiptStatus === 'reorged') {
            await this.markReorged(
              replayEntry,
              'persisted receipt disagrees with canonical chain truth',
            );
          } else if (receiptStatus === 'rejected') {
            await this.rejectEntry(
              replayEntry,
              'persisted transaction failed or contains no finalization event',
            );
          } else if (receiptStatus === 'unsupported') {
            await this.markUnsupported(replayEntry);
          } else {
            await this.recordDeferred(
              replayEntry,
              `persisted receipt is ${receiptStatus}`,
              deferredRetryDelay,
            );
          }
          this.log.info(
            `Finalization recovery receipt is ${receiptStatus} for ${replayEntry.ual}`,
          );
          return deferredRetryDelay !== undefined
            && (receiptStatus === 'pending' || receiptStatus === 'not-found')
            ? 'retry-pending' as const
            : 'none' as const;
        }
        const replayOutcome = await this.materializer.replayVerified({
          replay: input,
          entry: replayEntry,
          candidate,
          evidence,
        });
        outcome = replayOutcome === 'promoted'
          ? 'applied'
          : replayOutcome === 'already-confirmed' || replayOutcome === 'stale-target'
            ? 'already-confirmed'
            : 'deferred';
      } else {
        const recoverySourcePeerId = replayEntry.trustedPublisherPeerId
          ?? replayEntry.sourcePeerId;
        outcome = await this.materialize(
          {
            rawMessage: replayEntry.rawMessage,
            contextGraphId: replayEntry.contextGraphId,
            ...(recoverySourcePeerId ? { sourcePeerId: recoverySourcePeerId } : {}),
            candidate,
          },
          { kind: 'recovery', entry: replayEntry },
        );
      }

      if (outcome === 'deferred') {
        await this.recordDeferred(
          replayEntry,
          'replay processing deferred',
          deferredRetryDelay,
        );
        return deferredRetryDelay === undefined
          ? 'none' as const
          : 'retry-pending' as const;
      }
      const settled = await this.settleEntry(replayEntry, outcome);
      return settled ? 'recovered' as const : 'none' as const;
    } catch (error) {
      if (!this.materializer.isRetryableError(error)) throw error;
      this.log.info(
        `Finalization recovery materialization remains busy for ${entry.ual}; `
          + 'keeping inbox entry',
      );
      await this.recordDeferred(
        entry,
        'replay store scheduler remained busy',
        deferredRetryDelay,
      );
      return deferredRetryDelay === undefined
        ? 'none' as const
        : 'retry-pending' as const;
    }
  }

  /**
   * Make evidence recovery one explicit replay transition. Persisted evidence
   * is rejected on an envelope mismatch. Independently recovered evidence
   * falls back to normal materialization when it is absent, mismatched, or
   * cannot be committed.
   */
  private async ensureVerifiedReplayEntry(
    entry: FinalizationRecoveryEntry,
    candidate: ParsedGraphScopedFinalization,
    replay: FinalizationRecoveryReplayInput,
  ): Promise<EnsuredVerifiedReplayEntry> {
    const persistedEvidence = entry.state === 'VERIFIED';
    const evidence = persistedEvidence
      ? entry.verifiedEvidence
      : await this.materializer.recoverVerifiedEvidence({
          replay,
          entry,
          candidate,
        });
    if (!evidence) {
      if (persistedEvidence) {
        this.log.warn(
          `Finalization recovery VERIFIED entry has no evidence for ${entry.ual}`,
        );
        await this.rejectEntry(entry, 'verified entry has no evidence');
        return { status: 'invalid' };
      }
      return { status: 'unverified', entry };
    }

    const matchesImmutableEnvelope =
      VerifiedGraphScopedFinalizationEvidenceCodec.matchesImmutableEnvelope(
        evidence,
        candidate,
        entry,
      );
    const matchesEnvelope = persistedEvidence && entry.generation === 0
      ? VerifiedGraphScopedFinalizationEvidenceCodec.matchesEnvelope(
          evidence,
          candidate,
          entry,
        )
      : matchesImmutableEnvelope;
    if (!matchesEnvelope) {
      if (persistedEvidence) {
        this.log.warn(
          `Finalization recovery evidence does not match its envelope for ${entry.ual}`,
        );
        await this.rejectEntry(
          entry,
          'verified evidence does not match immutable envelope',
        );
        return { status: 'invalid' };
      }
      this.log.warn(
        `Finalization recovery ignored recovered evidence that does not match `
          + `its envelope for ${entry.ual}`,
      );
      return { status: 'unverified', entry };
    }

    if (persistedEvidence) {
      return { status: 'verified', entry, evidence };
    }

    let commitEntry = entry;
    if (
      entry.generation === 0
      && !VerifiedGraphScopedFinalizationEvidenceCodec.matchesEnvelope(
        evidence,
        candidate,
        entry,
      )
    ) {
      const reorged = await this.markReorged(
        entry,
        'independently recovered canonical receipt moved',
      );
      if (!reorged) return { status: 'unverified', entry };
      const current = await this.getStore()?.get(entry.key);
      if (
        !current
        || current.state !== 'REORGED'
        || current.generation !== entry.generation + 1
      ) {
        return { status: 'invalid' };
      }
      commitEntry = current;
    }

    const committed = await this.recordVerified(commitEntry, evidence);
    return committed
      ? { status: 'verified', entry: committed, evidence }
      : { status: 'unverified', entry: commitEntry };
  }

  private decodeEntry(
    entry: FinalizationRecoveryEntry,
  ): ParsedGraphScopedFinalization | undefined {
    try {
      const message = decodeFinalizationMessage(entry.rawMessage);
      if (message.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) return undefined;
      const admission = parseGraphScopedFinalization(message, entry.contextGraphId);
      return admission.ok ? admission.value : undefined;
    } catch (error) {
      this.log.warn(
        `Finalization recovery envelope decode failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private matchesImmutableStoredEnvelope(
    input: FinalizationRecoveryLiveInput,
    entry: FinalizationRecoveryEntry,
  ): boolean {
    const stored = this.decodeEntry(entry);
    return stored !== undefined
      && sameImmutableFinalizationCandidate(stored, input.candidate);
  }

  private async verifyContextGraphBinding(
    candidate: ParsedGraphScopedFinalization,
    prepared: Prepared,
  ): Promise<boolean> {
    const localTopicBinding = prepared.localTopicOnChainContextGraphId;
    if (!localTopicBinding) return false;
    const wireTarget = candidate.msg.targetContextGraphId;
    if (wireTarget && !sameBigIntValue(wireTarget, localTopicBinding)) {
      this.log.warn(
        `Finalization recovery wire context graph ${wireTarget} disagrees with `
          + `local topic mapping ${localTopicBinding} for ${candidate.scope.ual}`,
      );
      return false;
    }
    if (
      !this.chain
      || this.chain.chainId === 'none'
      || !this.chain.getKAContextGraphId
    ) return false;
    try {
      const bound = await this.chain.getKAContextGraphId(candidate.kaId);
      return bound !== null
        && bound !== undefined
        && sameBigIntValue(bound, localTopicBinding);
    } catch (error) {
      this.log.info(
        `Finalization recovery context-graph binding is pending for KA ${candidate.kaId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async verifyLegacy(
    candidate: ParsedGraphScopedFinalization,
    onChainContextGraphId?: string,
  ): Promise<{ verified: boolean; authorAddress?: string; txIndex?: number }> {
    if (!this.chain || this.chain.chainId === 'none' || candidate.blockNumber <= 0) {
      return { verified: false };
    }
    try {
      const filter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated', 'KCCreated'],
        fromBlock: candidate.blockNumber,
        toBlock: candidate.blockNumber,
      };
      let authorAddress: string | undefined;
      let txIndex: number | undefined;
      let batchVerified = false;
      for await (const event of this.chain.listenForEvents(filter)) {
        if (event.blockNumber !== candidate.blockNumber) continue;
        const eventTxHash = event.data['txHash'];
        if (
          typeof eventTxHash !== 'string'
          || eventTxHash.toLowerCase() !== candidate.msg.txHash.toLowerCase()
        ) continue;
        const eventMerkle = typeof event.data['merkleRoot'] === 'string'
          ? ethers.getBytes(event.data['merkleRoot'])
          : event.data['merkleRoot'] as Uint8Array;
        const publisher = String(event.data['publisherAddress'] ?? '');
        const startKAId = BigInt(event.data['startKAId'] as string ?? '0');
        const endKAId = BigInt(event.data['endKAId'] as string ?? '0');
        if (
          !equalBytes(eventMerkle, candidate.msg.kcMerkleRoot)
          || publisher.toLowerCase() !== candidate.msg.publisherAddress.toLowerCase()
          || startKAId !== candidate.startKAId
          || endKAId !== candidate.endKAId
        ) continue;
        batchVerified = true;
        const author = event.data['author'];
        if (typeof author === 'string' && author) authorAddress = author;
        const rawTxIndex = event.data['txIndex'];
        if (
          typeof rawTxIndex === 'number'
          && Number.isSafeInteger(rawTxIndex)
          && rawTxIndex >= 0
        ) txIndex = rawTxIndex;
        break;
      }
      if (!batchVerified) return { verified: false };
      if (!onChainContextGraphId) {
        return {
          verified: true,
          ...(authorAddress ? { authorAddress } : {}),
          ...(txIndex !== undefined ? { txIndex } : {}),
        };
      }
      if (this.chain.isV10Ready?.()) {
        return {
          verified: true,
          ...(authorAddress ? { authorAddress } : {}),
          ...(txIndex !== undefined ? { txIndex } : {}),
        };
      }
      try {
        const scanWindow = 256;
        const headBlock = this.chain.getBlockNumber
          ? await this.chain.getBlockNumber()
          : candidate.blockNumber + scanWindow;
        const contextGraphFilter: EventFilter = {
          eventTypes: ['ContextGraphExpanded'],
          fromBlock: candidate.blockNumber,
          toBlock: Math.min(candidate.blockNumber + scanWindow, headBlock),
        };
        for await (const event of this.chain.listenForEvents(contextGraphFilter)) {
          const eventContextGraphId = String(event.data['contextGraphId'] ?? '');
          const eventBatchId = BigInt(event.data['batchId'] as string ?? '0');
          if (
            eventContextGraphId === onChainContextGraphId
            && eventBatchId === candidate.batchId
          ) {
            return {
              verified: true,
              ...(authorAddress ? { authorAddress } : {}),
              ...(txIndex !== undefined ? { txIndex } : {}),
            };
          }
        }
        return { verified: false };
      } catch {
        return {
          verified: true,
          ...(authorAddress ? { authorAddress } : {}),
          ...(txIndex !== undefined ? { txIndex } : {}),
        };
      }
    } catch (error) {
      this.log.info(
        `Finalization recovery legacy verification is pending for `
          + `${candidate.scope.ual}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { verified: false };
    }
  }

  private async verifyPersistedReceipt(
    candidate: ParsedGraphScopedFinalization,
    evidence: VerifiedGraphScopedFinalizationEvidence,
    acceptCanonicalPlacement: boolean,
  ): Promise<FinalizationCanonicalReceiptOutcome['status']> {
    const outcome = await this.resolveCanonicalReceipt(
      candidate,
      evidence,
      { acceptCanonicalPlacement },
    );
    if (outcome.status !== 'confirmed') return outcome.status;
    const receipt = outcome.receipt;
    const expectedAuthor = evidence.authorAddress?.toLowerCase();
    const canonicalAuthor = receipt.authorAddress?.toLowerCase();
    return canonicalAuthor === expectedAuthor
      && sameCanonicalFinalizationPlacement(receipt, evidence)
      ? 'confirmed'
      : 'rejected';
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function sameCanonicalFinalizationPlacement(
  receipt: CanonicalFinalizationReceipt,
  evidence: VerifiedGraphScopedFinalizationEvidence,
): boolean {
  return receipt.txHash.toLowerCase() === evidence.transactionHash.toLowerCase()
    && receipt.blockNumber === evidence.blockNumber
    && receipt.blockHash.toLowerCase() === evidence.blockHash.toLowerCase()
    && receipt.txIndex === evidence.txIndex;
}

function sameGraphScopedAccessSemantics(
  prepared: FinalizationRecoveryPreparedMaterialization,
  evidence: VerifiedGraphScopedFinalizationEvidence,
): boolean {
  return prepared.accessPolicy === evidence.accessPolicy
    && [...prepared.allowedPeers].sort().join('\0')
      === [...evidence.allowedPeers].sort().join('\0');
}

function sameImmutableFinalizationCandidate(
  left: ParsedGraphScopedFinalization,
  right: ParsedGraphScopedFinalization,
): boolean {
  // Block placement comes from the canonical receipt; timestamps and operation ids
  // are transport correlation rather than finalization-event identity.
  const leftPrivateRoot = left.privateMerkleRoot
    ? ethers.hexlify(left.privateMerkleRoot).toLowerCase()
    : undefined;
  const rightPrivateRoot = right.privateMerkleRoot
    ? ethers.hexlify(right.privateMerkleRoot).toLowerCase()
    : undefined;
  return left.scope.ual === right.scope.ual
    && left.kaId === right.kaId
    && left.startKAId === right.startKAId
    && left.endKAId === right.endKAId
    && left.batchId === right.batchId
    && left.assertionVersion === right.assertionVersion
    && equalBytes(left.msg.kcMerkleRoot, right.msg.kcMerkleRoot)
    && left.msg.txHash.toLowerCase() === right.msg.txHash.toLowerCase()
    && left.msg.publisherAddress.toLowerCase() === right.msg.publisherAddress.toLowerCase()
    && left.publicTripleCount === right.publicTripleCount
    && left.privateTripleCount === right.privateTripleCount
    && leftPrivateRoot === rightPrivateRoot
    && (left.msg.contextGraphId || undefined) === (right.msg.contextGraphId || undefined)
    && (left.msg.targetContextGraphId || undefined)
      === (right.msg.targetContextGraphId || undefined)
    && (left.msg.subGraphName || undefined) === (right.msg.subGraphName || undefined)
    && left.msg.keepRootCopyOnLabel === right.msg.keepRootCopyOnLabel
    && left.wireAccessPolicy === right.wireAccessPolicy
    && [...left.allowedPeers].sort().join('\0') === [...right.allowedPeers].sort().join('\0');
}

function sameBigIntValue(
  left: string | number | bigint,
  right: string | number | bigint,
): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}
