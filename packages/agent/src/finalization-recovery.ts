import type { FinalizationMessageMsg } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import type {
  ParsedGraphScopedFinalization,
  VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';
import {
  FinalizationRecoveryJournal,
  finalizationRecoveryEntryKey,
  type FinalizationRecoveryEntry,
  type FinalizationRecoveryTrust,
} from './finalization-recovery-journal.js';

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

/**
 * Owns bounded journal persistence and chain-gated candidate selection. The
 * handler remains the sole replay coordinator, so recovery never calls back
 * into the handler that owns it.
 */
export class FinalizationRecovery {
  constructor(
    private readonly journal: FinalizationRecoveryJournal | undefined,
    private readonly chain: ChainAdapter | undefined,
    private readonly log: FinalizationRecoveryLog,
  ) {}

  recordRawOnBusy(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
    candidate: ParsedGraphScopedFinalization;
  }): Promise<boolean> {
    return this.record({ ...input, state: 'raw' });
  }

  recordVerified(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
    candidate: ParsedGraphScopedFinalization;
    verifiedEvidence: VerifiedGraphScopedFinalizationEvidence;
  }): Promise<boolean> {
    return this.record({ ...input, state: 'verified' });
  }

  async settle(
    msg: FinalizationMessageMsg,
    contextGraphId: string,
    outcome: FinalizationRecoveryApplyOutcome,
  ): Promise<void> {
    if (outcome === 'deferred') return;
    await this.remove(finalizationRecoveryEntryKey({
      chainId: this.chain?.chainId ?? 'none',
      contextGraphId,
      ual: msg.ual,
      txHash: msg.txHash,
    }), msg.ual);
  }

  async settleEntry(
    entry: FinalizationRecoveryEntry,
    outcome: FinalizationRecoveryApplyOutcome,
  ): Promise<boolean> {
    if (outcome === 'deferred') return false;
    return this.remove(entry.key, entry.ual);
  }

  async matchingEntries(input: FinalizationRecoveryReplayInput): Promise<FinalizationRecoveryEntry[]> {
    if (!this.journal) return [];
    if (
      !this.chain?.getLatestMerkleRoot
      || !this.chain.getMerkleRootCount
      || !this.chain.getKAContextGraphId
    ) return [];

    let entries: FinalizationRecoveryEntry[];
    try {
      entries = await this.journal.forKnowledgeAsset(input);
    } catch (error) {
      this.log.warn(
        `Finalization recovery journal read failed: ${error instanceof Error ? error.message : String(error)}`,
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
          this.chain.getKAContextGraphId(BigInt(entry.kaId)),
        ]);
        if (rootCount > assertionVersion) {
          await this.journal.remove(entry.key);
          this.log.info(
            `Finalization recovery discarded superseded assertion ${entry.assertionVersion} for ${entry.ual}`,
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

  private async record(input: {
    rawMessage: Uint8Array;
    contextGraphId: string;
    sourcePeerId?: string;
    candidate: ParsedGraphScopedFinalization;
    state: FinalizationRecoveryTrust;
    verifiedEvidence?: VerifiedGraphScopedFinalizationEvidence;
  }): Promise<boolean> {
    if (!this.journal) return false;
    const { candidate } = input;
    try {
      const persisted = await this.journal.upsert({
        state: input.state,
        chainId: this.chain?.chainId ?? 'none',
        contextGraphId: input.contextGraphId,
        ...(input.sourcePeerId ? { sourcePeerId: input.sourcePeerId } : {}),
        ual: candidate.scope.ual,
        txHash: candidate.msg.txHash,
        assertionVersion: candidate.assertionVersion,
        merkleRoot: ethers.hexlify(candidate.msg.kcMerkleRoot),
        kaId: candidate.kaId.toString(),
        ...(candidate.msg.targetContextGraphId
          ? { targetContextGraphId: candidate.msg.targetContextGraphId }
          : {}),
        rawMessage: input.rawMessage,
        ...(input.verifiedEvidence ? { verifiedEvidence: input.verifiedEvidence } : {}),
      });
      if (!persisted) {
        this.log.warn(
          `Finalization recovery journal rejected ${candidate.scope.ual}; `
            + 'capacity, envelope limit, or conflicting identity-bound evidence',
        );
      }
      return persisted;
    } catch (error) {
      this.log.warn(
        `Finalization recovery journal write failed for ${candidate.scope.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async remove(key: string, ual: string): Promise<boolean> {
    if (!this.journal) return false;
    try {
      return await this.journal.remove(key);
    } catch (error) {
      this.log.warn(
        `Finalization recovery journal cleanup failed for ${ual}: `
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
