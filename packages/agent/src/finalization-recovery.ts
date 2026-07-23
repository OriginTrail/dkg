import type {
  CanonicalFinalizationReceipt,
  CanonicalFinalizationReceiptResolution,
  ChainAdapter,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import {
  VerifiedGraphScopedFinalizationEvidenceCodec,
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

export interface FinalizationRecoveryLiveCallbacks {
  apply(entry: FinalizationRecoveryEntry): Promise<FinalizationRecoveryApplyOutcome>;
  isRetryableError(error: unknown): boolean;
}

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

export interface FinalizationRecoveryReplayCallbacks {
  decode(entry: FinalizationRecoveryEntry): ParsedGraphScopedFinalization | undefined;
  applyReceived(input: {
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
  }): Promise<FinalizationRecoveryApplyOutcome>;
  applyVerified(input: {
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    evidence: VerifiedGraphScopedFinalizationEvidence;
  }): Promise<FinalizationRecoveryApplyOutcome>;
  isRetryableError(error: unknown): boolean;
}

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
export class FinalizationRecovery {
  private readonly replaySingleFlights = new Map<string, Promise<boolean>>();

  constructor(
    private readonly store: FinalizationRecoveryStore | undefined,
    private readonly chain: ChainAdapter | undefined,
    private readonly log: FinalizationRecoveryLog,
  ) {}

  /**
   * Applies a live graph-scoped finalization behind the durable write-ahead
   * boundary. Returns false only when no recovery store is configured.
   */
  async processLive(
    input: FinalizationRecoveryLiveInput,
    callbacks: FinalizationRecoveryLiveCallbacks,
  ): Promise<boolean> {
    if (!this.store) return false;
    const entry = await this.receive(input);
    // A configured inbox fails closed: capacity, conflict, corruption, and
    // write failures leave Oxigraph untouched.
    if (!entry) return true;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const outcome = await callbacks.apply(entry);
        if (outcome === 'deferred') {
          await this.recordDeferred(entry, 'finalization processing deferred');
        } else {
          await this.settleEntry(entry, outcome);
        }
        return true;
      } catch (error) {
        if (!callbacks.isRetryableError(error)) throw error;
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

  async receive(
    input: FinalizationRecoveryLiveInput,
  ): Promise<FinalizationRecoveryEntry | undefined> {
    if (!this.store) return undefined;
    const { candidate } = input;
    const key = finalizationRecoveryEntryKey({
      chainId: this.chain?.chainId ?? 'none',
      contextGraphId: input.contextGraphId,
      ual: candidate.scope.ual,
      txHash: candidate.msg.txHash,
    });
    try {
      const result = await this.store.receive({
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

  async recordVerified(
    entry: FinalizationRecoveryEntry,
    evidence: VerifiedGraphScopedFinalizationEvidence,
  ): Promise<FinalizationRecoveryEntry | undefined> {
    if (!this.store) return undefined;
    try {
      const result = await this.store.markVerified(entry.key, evidence);
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
    if (!this.store || outcome === 'deferred') return false;
    return this.transition(entry, 'SETTLED');
  }

  async recordDeferred(entry: FinalizationRecoveryEntry, reason: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.recordAttempt(entry.key, reason);
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
    if (!this.store) return [];
    if (
      !this.chain?.getLatestMerkleRoot
      || !this.chain.getMerkleRootCount
      || !this.chain.getKAContextGraphId
    ) return [];

    let entries: FinalizationRecoveryEntry[];
    try {
      entries = await this.store.listForKnowledgeAsset(input);
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
    callbacks: FinalizationRecoveryReplayCallbacks,
  ): Promise<boolean> {
    const entries = await this.matchingEntries(input);
    let recovered = false;
    for (const entry of entries) {
      const existing = this.replaySingleFlights.get(entry.key);
      const replay = existing ?? this.replayEntry(entry, callbacks);
      if (!existing) this.replaySingleFlights.set(entry.key, replay);
      if (await replay) recovered = true;
    }
    return recovered;
  }

  async health(): Promise<FinalizationRecoveryHealth> {
    if (!this.store) {
      return {
        available: false,
        closed: false,
        degradedReason: 'not-configured',
        stateCounts: {},
        livePayloadBytes: 0,
      };
    }
    return this.store.health();
  }

  private async transition(
    entry: FinalizationRecoveryEntry,
    state: 'SETTLED' | 'SUPERSEDED' | 'REJECTED' | 'UNSUPPORTED',
    reason?: string,
  ): Promise<boolean> {
    if (!this.store) return false;
    try {
      return await this.store.transition(entry.key, state, reason);
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
    callbacks: FinalizationRecoveryReplayCallbacks,
  ): Promise<boolean> {
    const replay = (async () => {
      try {
        const candidate = callbacks.decode(entry);
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
          outcome = await callbacks.applyVerified({ entry, candidate, evidence });
        } else {
          outcome = await callbacks.applyReceived({ entry, candidate });
        }

        if (outcome === 'deferred') {
          await this.recordDeferred(entry, 'replay processing deferred');
          return false;
        }
        return this.settleEntry(entry, outcome);
      } catch (error) {
        if (!callbacks.isRetryableError(error)) throw error;
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
