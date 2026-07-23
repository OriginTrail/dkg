import type {
  CanonicalFinalizationReceipt,
  CanonicalFinalizationReceiptResolution,
  ChainAdapter,
  EventFilter,
} from '@origintrail-official/dkg-chain';
import {
  decodeFinalizationMessage,
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
    txIndex: number;
    authorAddress?: string;
  }
  | {
    status: 'deferred';
    reason:
      | 'legacy-verification-pending'
      | 'canonical-receipt-pending'
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

export type FinalizationRecoveryReplayMaterializationOutcome =
  | 'promoted'
  | 'already-confirmed'
  | 'stale-target'
  | 'no-swm'
  | 'verified-vm-metadata-pending'
  | undefined;

export interface FinalizationRecoveryMaterializer<
  Prepared extends FinalizationRecoveryPreparedMaterialization,
> {
  prepare(input: FinalizationRecoveryLiveInput): Promise<Prepared | undefined>;
  apply(input: {
    prepared: Prepared;
    txIndex: number;
    authorAddress?: string;
  }): Promise<FinalizationRecoveryApplyOutcome>;
  replayVerified(input: {
    replay: FinalizationRecoveryReplayInput;
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    evidence: VerifiedGraphScopedFinalizationEvidence;
  }): Promise<FinalizationRecoveryReplayMaterializationOutcome>;
  isRetryableError(error: unknown): boolean;
}

export type FinalizationRecoveryStoreProvider =
  () => FinalizationRecoveryStore | undefined;

type FinalizationVerificationContext =
  | { kind: 'live' }
  | { kind: 'recovery'; entry: FinalizationRecoveryEntry };

export type FinalizationCanonicalReceiptOutcome =
  | { status: 'confirmed'; receipt: CanonicalFinalizationReceipt }
  | { status: 'pending' | 'reorged' | 'rejected' | 'not-found' | 'unsupported' };

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
  private readonly replaySingleFlights = new Map<string, Promise<boolean>>();
  private readonly getStore: FinalizationRecoveryStoreProvider;

  constructor(
    store: FinalizationRecoveryStore | FinalizationRecoveryStoreProvider | undefined,
    private readonly chain: ChainAdapter | undefined,
    private readonly log: FinalizationRecoveryLog,
    private readonly materializer: FinalizationRecoveryMaterializer<Prepared>,
  ) {
    this.getStore = typeof store === 'function' ? store : () => store;
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
   * boundary. Returns false when durable recovery is unavailable so the caller
   * can preserve the legacy live-verification path.
   */
  async processLive(
    input: FinalizationRecoveryLiveInput,
  ): Promise<boolean> {
    const store = this.getStore();
    // The receipt API is intentionally optional on ChainAdapter. Preserve the
    // legacy live path when it is absent instead of admitting an envelope that
    // this runtime can never promote to VERIFIED.
    if (
      !store
      || !this.chain
      || this.chain.chainId === 'none'
      || !this.chain.resolveCanonicalFinalizationReceipt
    ) return false;
    const entry = await this.receive(input);
    // A configured inbox fails closed: capacity, conflict, corruption, and
    // write failures leave Oxigraph untouched.
    if (!entry) return true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const outcome = await this.materialize(input, { kind: 'recovery', entry });
        if (outcome === 'deferred') {
          await this.recordDeferred(entry, 'finalization processing deferred');
        } else {
          await this.settleEntry(entry, outcome);
        }
        return true;
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
        await this.recordDeferred(entry, 'store scheduler remained busy');
        return true;
      }
    }
    return true;
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
    const store = this.getStore();
    if (!store) return undefined;
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
      if (result.status === 'inserted' || result.status === 'existing') {
        if (result.entry.state === 'RECEIVED' || result.entry.state === 'VERIFIED') {
          return result.entry;
        }
        return undefined;
      }
      this.log.warn(
        `Finalization recovery inbox rejected ${candidate.scope.ual}: ${result.status}`,
      );
      return undefined;
    } catch (error) {
      this.log.warn(
        `Finalization recovery inbox write failed for ${candidate.scope.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  async resolveCanonicalReceipt(
    candidate: ParsedGraphScopedFinalization,
    persisted?: VerifiedGraphScopedFinalizationEvidence,
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
      || receipt.blockNumber !== candidate.blockNumber
      || !equalBytes(receipt.merkleRoot, candidate.msg.kcMerkleRoot)
      || receipt.publisherAddress.toLowerCase() !== candidate.msg.publisherAddress.toLowerCase()
      || receipt.batchId !== candidate.batchId
      || receipt.kaId !== candidate.kaId
      || receipt.startKAId !== candidate.startKAId
      || receipt.endKAId !== candidate.endKAId
      || !Number.isSafeInteger(receipt.txIndex)
      || receipt.txIndex < 0
      || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)
    ) {
      return { status: 'reorged' };
    }
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
        txIndex,
        ...(legacy.authorAddress ? { authorAddress: legacy.authorAddress } : {}),
      };
    }

    const { entry } = context;
    const canonical = await this.resolveCanonicalReceipt(candidate, entry.verifiedEvidence);
    if (canonical.status === 'unsupported') {
      await this.markUnsupported(entry);
      this.log.warn(
        `Finalization recovery canonical receipt is unsupported for ${entry.ual}`,
      );
      return { status: 'deferred', reason: 'canonical-receipt-unsupported' };
    }
    if (canonical.status === 'reorged' || canonical.status === 'rejected') {
      await this.rejectEntry(
        entry,
        canonical.status === 'reorged'
          ? 'canonical receipt mismatch or reorg'
          : 'transaction failed or contains no finalization event',
      );
      this.log.warn(
        `Finalization recovery canonical receipt is ${canonical.status} for ${entry.ual}`,
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
    const prepared = await this.materializer.prepare(input);
    if (!prepared) return 'deferred';
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
      txIndex: verification.txIndex,
      ...(verification.authorAddress
        ? { authorAddress: verification.authorAddress }
        : {}),
    });
  }

  async recordVerified(
    entry: FinalizationRecoveryEntry,
    evidence: VerifiedGraphScopedFinalizationEvidence,
  ): Promise<FinalizationRecoveryEntry | undefined> {
    const store = this.getStore();
    if (!store) return undefined;
    try {
      const result = await store.markVerified(entry.key, evidence);
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

  async recordDeferred(entry: FinalizationRecoveryEntry, reason: string): Promise<void> {
    const store = this.getStore();
    if (!store) return;
    try {
      await store.recordAttempt(entry.key, reason);
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
      return [];
    }

    const matches: FinalizationRecoveryEntry[] = [];
    const superseded: FinalizationRecoveryEntry[] = [];
    for (const entry of entries) {
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
    return matches;
  }

  async replayMatching(
    input: FinalizationRecoveryReplayInput,
  ): Promise<boolean> {
    const entries = await this.matchingEntries(input);
    let recovered = false;
    for (const entry of entries) {
      const existing = this.replaySingleFlights.get(entry.key);
      const replay = existing ?? this.replayEntry(entry, input);
      if (!existing) this.replaySingleFlights.set(entry.key, replay);
      if (await replay) recovered = true;
    }
    return recovered;
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
      return await store.transition(entry.key, state, reason);
    } catch (error) {
      this.log.warn(
        `Finalization recovery transition to ${state} failed for ${entry.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private replayEntry(
    entry: FinalizationRecoveryEntry,
    input: FinalizationRecoveryReplayInput,
  ): Promise<boolean> {
    const replay = (async () => {
      try {
        const candidate = this.decodeEntry(entry);
        if (!candidate) return false;

        let outcome: FinalizationRecoveryApplyOutcome;
        if (entry.state === 'VERIFIED' && entry.verifiedEvidence) {
          const evidence = entry.verifiedEvidence;
          if (!VerifiedGraphScopedFinalizationEvidenceCodec.matchesEnvelope(
            evidence,
            candidate,
            entry,
          )) {
            this.log.warn(
              `Finalization recovery evidence does not match its envelope for ${entry.ual}`,
            );
            await this.rejectEntry(entry, 'verified evidence does not match immutable envelope');
            return false;
          }
          const receiptStatus = await this.verifyPersistedReceipt(candidate, evidence);
          if (receiptStatus !== 'confirmed') {
            if (receiptStatus === 'reorged' || receiptStatus === 'rejected') {
              await this.rejectEntry(
                entry,
                'persisted receipt disagrees with canonical chain truth',
              );
            } else if (receiptStatus === 'unsupported') {
              await this.markUnsupported(entry);
            } else {
              await this.recordDeferred(entry, `persisted receipt is ${receiptStatus}`);
            }
            this.log.info(
              `Finalization recovery receipt is ${receiptStatus} for ${entry.ual}`,
            );
            return false;
          }
          const replayOutcome = await this.materializer.replayVerified({
            replay: input,
            entry,
            candidate,
            evidence,
          });
          outcome = replayOutcome === 'promoted'
            ? 'applied'
            : replayOutcome === 'already-confirmed' || replayOutcome === 'stale-target'
              ? 'already-confirmed'
              : 'deferred';
        } else {
          outcome = await this.materialize(
            {
              rawMessage: entry.rawMessage,
              contextGraphId: entry.contextGraphId,
              ...(entry.sourcePeerId ? { sourcePeerId: entry.sourcePeerId } : {}),
              candidate,
            },
            { kind: 'recovery', entry },
          );
        }

        if (outcome === 'deferred') {
          await this.recordDeferred(entry, 'replay processing deferred');
          return false;
        }
        return this.settleEntry(entry, outcome);
      } catch (error) {
        if (!this.materializer.isRetryableError(error)) throw error;
        this.log.info(
          `Finalization recovery materialization remains busy for ${entry.ual}; `
            + 'keeping inbox entry',
        );
        await this.recordDeferred(entry, 'replay store scheduler remained busy');
        return false;
      }
    })().finally(() => {
      if (this.replaySingleFlights.get(entry.key) === replay) {
        this.replaySingleFlights.delete(entry.key);
      }
    });
    return replay;
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
  ): Promise<FinalizationCanonicalReceiptOutcome['status']> {
    const outcome = await this.resolveCanonicalReceipt(candidate, evidence);
    if (outcome.status !== 'confirmed') return outcome.status;
    const receipt = outcome.receipt;
    const expectedAuthor = evidence.authorAddress?.toLowerCase();
    const canonicalAuthor = receipt.authorAddress?.toLowerCase();
    return canonicalAuthor === expectedAuthor
      && receipt.txIndex === evidence.txIndex
      && receipt.blockHash.toLowerCase() === evidence.blockHash.toLowerCase()
      ? 'confirmed'
      : 'rejected';
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
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
