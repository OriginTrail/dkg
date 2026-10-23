import { createHash } from 'node:crypto';
import { decode, encode } from 'cborg';
import type { SemanticRuntimeStore } from './persistence.js';

export interface TerminalExecutionReceipt {
  contextGraphId: string;
  name: string;
  agentAddress: string;
  layer: 'wm' | 'swm' | 'vm';
  requestIdentity: string;
  quads: Array<{ subject: string; predicate: string; object: string }>;
  outputs: string[];
}
export interface ReceiptProgress {
  phase: 'prepared' | 'create' | 'write' | 'finalize' | 'sealed' | 'share' | 'shared' | 'publish' | 'completed';
  assertion?: string;
}
const TERMINAL = 'execution-terminal-receipt-v1';
const PROGRESS = 'execution-receipt-progress-v1';

/** Terminal guest output and lifecycle intents share the existing FULL-sync event journal.
 * A retry can finish the receipt without replaying a JavaScript continuation or any tool. */
export class ExecutionReceiptJournal {
  terminal?: TerminalExecutionReceipt;
  progress: ReceiptProgress = { phase: 'prepared' };
  constructor(private readonly store: SemanticRuntimeStore, private readonly executionId: string) {
    store.verifyRuntimeEventChain(executionId);
    for (const event of store.runtimeEventsAfter(executionId, 0n)) {
      if (event.eventType === TERMINAL) {
        if (this.terminal) throw new Error('duplicate terminal execution receipt');
        this.terminal = decode(event.cbor) as TerminalExecutionReceipt;
      } else if (event.eventType === PROGRESS) {
        if (!this.terminal) throw new Error('receipt progress without terminal execution');
        this.progress = decode(event.cbor) as ReceiptProgress;
      }
    }
  }
  prepare(receipt: TerminalExecutionReceipt): void {
    if (this.terminal) throw new Error('terminal execution receipt already exists');
    this.append(TERMINAL, receipt);
    this.terminal = structuredClone(receipt);
  }
  checkpoint(progress: ReceiptProgress): void {
    if (!this.terminal) throw new Error('receipt progress requires terminal execution');
    if (progress.phase === this.progress.phase && progress.assertion === this.progress.assertion) return;
    this.append(PROGRESS, progress);
    this.progress = { ...progress };
  }
  private append(eventType: string, value: unknown): void {
    const execution = this.store.execution(this.executionId);
    if (!execution) throw new Error('receipt requires a durable execution');
    const bytes = encode(value);
    this.store.commitRuntimeTransition({ executionId: this.executionId, expectedNextSeq: execution.nextEventSeq,
      eventId: eventType === TERMINAL ? 'receipt:terminal:v1' : `receipt:${execution.nextEventSeq}`, eventType, eventCbor: bytes,
      stateDigest: createHash('sha256').update(bytes).digest() });
  }
}
