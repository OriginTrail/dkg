import type {
  CanonicalFinalizationReceipt,
  CanonicalFinalizationReceiptResolution,
  ChainAdapter,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import type {
  ParsedGraphScopedFinalization,
  VerifiedGraphScopedFinalizationEvidence,
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
  constructor(
    private readonly store: FinalizationRecoveryStore | undefined,
    private readonly chain: ChainAdapter | undefined,
    private readonly log: FinalizationRecoveryLog,
  ) {}

  get enabled(): boolean {
    return this.store !== undefined;
  }

  async receive(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
    candidate: ParsedGraphScopedFinalization;
  }): Promise<FinalizationRecoveryEntry | undefined> {
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

    const matches: FinalizationRecoveryEntry[] = [];
    for (const entry of entries) {
      if (
        entry.targetContextGraphId !== undefined
        && entry.targetContextGraphId !== input.onChainCgId
      ) continue;
      try {
        const assertionVersion = BigInt(entry.assertionVersion);
        const [latestRoot, rootCount, boundContextGraphId] = await Promise.all([
          this.chain.getLatestMerkleRoot(BigInt(entry.kaId)),
          this.chain.getMerkleRootCount(BigInt(entry.kaId)),
          this.chain.getKAContextGraphId(BigInt(input.kaId)),
        ]);
        if (rootCount > assertionVersion) {
          await this.transition(
            entry,
            'SUPERSEDED',
            `canonical assertion version advanced to ${rootCount}`,
          );
          this.log.info(
            `Finalization recovery superseded assertion ${entry.assertionVersion} for ${entry.ual}`,
          );
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
          `Finalization recovery chain state is not settled for ${entry.ual}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return matches;
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
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}
