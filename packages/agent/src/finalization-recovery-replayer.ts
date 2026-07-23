import { decodeFinalizationMessage } from '@origintrail-official/dkg-core';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import {
  parseGraphScopedFinalization,
  verifiedEvidenceMatchesParsedEnvelope,
  type ParsedGraphScopedFinalization,
  type VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';
import type { FinalizationRecoveryEntry } from './finalization-recovery-journal.js';
import {
  FinalizationRecovery,
  type FinalizationRecoveryApplyOutcome,
} from './finalization-recovery.js';

export interface FinalizationRecoveryReplayTarget {
  chainId: string;
  contextGraphId: string;
  onChainCgId: string;
  ual: string;
  merkleRoot: Uint8Array;
  kaId: bigint;
}

export type VerifiedFinalizationRecoveryApplyOutcome =
  | 'promoted'
  | 'already-confirmed'
  | 'stale-target'
  | 'no-swm'
  | 'verified-vm-metadata-pending'
  | undefined;

interface FinalizationRecoveryReplayerCallbacks {
  verifyCanonicalReceipt(input: {
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    evidence: VerifiedGraphScopedFinalizationEvidence;
    target: FinalizationRecoveryReplayTarget;
  }): Promise<boolean>;
  applyRaw(input: {
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    rawMessage: Uint8Array;
  }): Promise<FinalizationRecoveryApplyOutcome>;
  applyVerified(input: {
    entry: FinalizationRecoveryEntry;
    candidate: ParsedGraphScopedFinalization;
    evidence: VerifiedGraphScopedFinalizationEvidence;
    target: FinalizationRecoveryReplayTarget;
  }): Promise<VerifiedFinalizationRecoveryApplyOutcome>;
}

interface FinalizationRecoveryReplayerLog {
  info(message: string): void;
  warn(message: string): void;
}

/** Owns durable replay mode selection, validation, single-flight, and settlement. */
export class FinalizationRecoveryReplayer {
  private readonly singleFlights = new Map<string, Promise<boolean>>();

  constructor(
    private readonly recovery: FinalizationRecovery,
    private readonly callbacks: FinalizationRecoveryReplayerCallbacks,
    private readonly log: FinalizationRecoveryReplayerLog,
  ) {}

  async replayMatching(target: FinalizationRecoveryReplayTarget): Promise<boolean> {
    const entries = await this.recovery.matchingEntries({
      chainId: target.chainId,
      contextGraphId: target.contextGraphId,
      onChainCgId: target.onChainCgId,
      ual: target.ual,
      merkleRoot: ethers.hexlify(target.merkleRoot),
      kaId: target.kaId.toString(),
    });
    let recovered = false;
    for (const entry of entries) {
      const existing = this.singleFlights.get(entry.key);
      const replay = existing ?? this.replayEntry(entry, target);
      if (!existing) this.singleFlights.set(entry.key, replay);
      if (await replay) recovered = true;
    }
    return recovered;
  }

  private replayEntry(
    entry: FinalizationRecoveryEntry,
    target: FinalizationRecoveryReplayTarget,
  ): Promise<boolean> {
    const replay = (async () => {
      try {
        const rawMessage = Buffer.from(entry.rawMessageBase64, 'base64');
        let candidate: ParsedGraphScopedFinalization;
        try {
          const admission = parseGraphScopedFinalization(
            decodeFinalizationMessage(rawMessage),
            entry.contextGraphId,
          );
          if (!admission.ok) {
            this.log.warn(`Finalization recovery envelope failed admission for ${entry.ual}: ${admission.reason}`);
            return false;
          }
          candidate = admission.value;
        } catch (error) {
          this.log.warn(
            `Finalization recovery envelope decode failed for ${entry.ual}: `
              + `${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }

        let outcome: FinalizationRecoveryApplyOutcome;
        if (entry.state === 'verified' && entry.verifiedEvidence) {
          const evidence = entry.verifiedEvidence;
          if (!verifiedEvidenceMatchesParsedEnvelope(evidence, candidate, entry)) {
            this.log.warn(`Finalization recovery evidence does not match its envelope for ${entry.ual}`);
            return false;
          }
          if (!await this.callbacks.verifyCanonicalReceipt({ entry, candidate, evidence, target })) {
            this.log.info(`Finalization recovery receipt is not canonical for ${entry.ual}; keeping journal entry`);
            return false;
          }
          const applyOutcome = await this.callbacks.applyVerified({ entry, candidate, evidence, target });
          outcome = applyOutcome === 'promoted'
            ? 'applied'
            : applyOutcome === 'already-confirmed' || applyOutcome === 'stale-target'
              ? 'already-confirmed'
              : 'deferred';
        } else {
          outcome = await this.callbacks.applyRaw({ entry, candidate, rawMessage });
        }
        return this.recovery.settleEntry(entry, outcome);
      } catch (error) {
        if (!(error instanceof StoreSchedulerBusyError)) throw error;
        this.log.info(`Finalization recovery store remains busy for ${entry.ual}; keeping journal entry`);
        return false;
      }
    })().finally(() => {
      if (this.singleFlights.get(entry.key) === replay) this.singleFlights.delete(entry.key);
    });
    return replay;
  }
}
