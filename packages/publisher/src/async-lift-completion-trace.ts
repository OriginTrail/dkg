import { createHash } from 'node:crypto';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';

type CompletionEvent = 'accepted_primary_committed' | 'terminal_primary_committed'
  | 'terminal_operation_settled' | 'wallet_ownership_released' | 'finality_observed';

export interface CompletionTraceSources {
  enabled(): boolean;
  clock(): number;
  monotonicNs(): bigint;
  wallClock(): number;
  write(line: string): void;
}

const logger = new Logger('AsyncLiftPublisher');
const sources: CompletionTraceSources = {
  enabled: () => process.env.DKG_ASYNC_PUBLISH_COMPLETION_TRACE === '1',
  clock: () => performance.now(),
  monotonicNs: () => process.hrtime.bigint(),
  wallClock: () => Date.now(),
  write: (line) => logger.info(createOperationContext('publish', 'completion-trace'), line),
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Unthresholded, opt-in observations only. Call sites own every lifecycle boundary. */
export class AsyncLiftCompletionTrace {
  private sequence = 0;

  constructor(private readonly source: CompletionTraceSources = sources) {}

  get enabled(): boolean {
    try { return this.source.enabled(); } catch { return false; }
  }

  acceptedPrimaryCommitted(jobId: string): void { this.emit('accepted_primary_committed', jobId); }
  terminalPrimaryCommitted(jobId: string): void { this.emit('terminal_primary_committed', jobId); }
  terminalOperationSettled(jobId: string): void { this.emit('terminal_operation_settled', jobId); }
  finalityObserved(jobId: string, txHash: string): void { this.emit('finality_observed', jobId, { txHash }); }
  walletOwnershipReleased(jobId: string, walletId: string, claimToken?: string): void {
    this.emit('wallet_ownership_released', jobId, { walletId, claimToken });
  }

  private emit(
    event: CompletionEvent,
    jobId: string,
    context: { txHash?: string; walletId?: string; claimToken?: string } = {},
  ): void {
    try {
      if (!this.enabled) return;
      const monotonicMs = this.source.clock();
      const hrtimeNs = this.source.monotonicNs().toString();
      const wallTimeMs = this.source.wallClock();
      this.source.write(`async_publish_completion_trace ${JSON.stringify({
        schemaVersion: 1, processId: process.pid, sequence: ++this.sequence,
        event, jobId, monotonicMs, hrtimeNs, wallTimeMs,
        ...(context.txHash === undefined ? {} : { txHash: context.txHash }),
        ...(context.walletId === undefined ? {} : { walletHash: hash(context.walletId) }),
        ...(context.claimToken === undefined ? {} : { claimEpochHash: hash(context.claimToken) }),
      })}`);
    } catch { /* Diagnostics never change a committed mutation or its completion. */ }
  }
}

export const completionTrace = new AsyncLiftCompletionTrace();
