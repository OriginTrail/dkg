import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import { emitTrace, isTraceEnabled, type TraceSources } from './async-lift-trace-emitter.js';

type CompletionEvent = 'accepted_primary_committed' | 'terminal_primary_committed'
  | 'terminal_operation_settled' | 'wallet_ownership_released' | 'finality_observed';

export interface CompletionTraceSources extends TraceSources {
  monotonicNs(): bigint;
}

const logger = new Logger('AsyncLiftPublisher');
const sources: CompletionTraceSources = {
  enabled: () => process.env.DKG_ASYNC_PUBLISH_COMPLETION_TRACE === '1',
  clock: () => performance.now(),
  monotonicNs: () => process.hrtime.bigint(),
  wallClock: () => Date.now(),
  write: (line) => logger.info(createOperationContext('publish', 'completion-trace'), line),
};

/** Unthresholded, opt-in observations only. Call sites own every lifecycle boundary. */
export class AsyncLiftCompletionTrace {
  private sequence = 0;

  constructor(private readonly source: CompletionTraceSources = sources) {}

  get enabled(): boolean {
    return isTraceEnabled(this.source);
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
    emitTrace(this.source, 'async_publish_completion_trace ', 'native-first', event, () => ({
      sequence: ++this.sequence, jobId,
      ...(context.txHash === undefined ? {} : { txHash: context.txHash }),
    }), context.walletId, context.claimToken);
  }
}

export const completionTrace = new AsyncLiftCompletionTrace();
