import type { PeerOutcome } from './ack-errors.js';

export type ACKDiagnosticEvent =
  | { kind: 'attempt_started'; active: number }
  | { kind: 'attempt'; durationMs: number }
  | { kind: 'backoff'; durationMs: number; reason: 'transport' | 'transient_decline' }
  | { kind: 'outcomes'; counts: { total: number; ack: number; declined: number; invalid: number;
      unsupported: number; transport: number; pending: number } };

/** Fixed-field diagnostics. Never forwards peer strings, graph IDs or payloads. */
export class ACKRoundDiagnostics {
  private closed = false;
  private active = 0;
  constructor(private readonly observer?: (event: ACKDiagnosticEvent) => void,
    private readonly now = () => performance.now()) {}

  private emit(event: ACKDiagnosticEvent): void {
    if (this.closed) return;
    try { this.observer?.(event); } catch { /* observability cannot change ACK decisions */ }
  }

  async measure<T>(kind: 'attempt' | 'backoff', work: () => Promise<T>, reason: 'transport' | 'transient_decline' = 'transport'): Promise<T> {
    const started = this.now();
    if (kind === 'attempt') this.emit({ kind: 'attempt_started', active: ++this.active });
    try { return await work(); } finally {
      if (kind === 'attempt') this.active--;
      const durationMs = Math.max(0, this.now() - started);
      this.emit(kind === 'attempt' ? { kind, durationMs } : { kind, durationMs, reason });
    }
  }

  finish(outcomes: readonly PeerOutcome[]): void {
    const counts = { total: outcomes.length, ack: 0, declined: 0, invalid: 0, unsupported: 0, transport: 0, pending: 0 };
    for (const { reason } of outcomes) {
      if (reason === 'ACK' || reason?.startsWith('ACK:')) counts.ack++;
      else if (reason?.startsWith('STORAGE_ACK_DECLINE:')) counts.declined++;
      else if (reason === 'TRANSPORT_ERROR') counts.transport++;
      else if (reason === 'PROTOCOL_UNSUPPORTED') counts.unsupported++;
      else if (reason === 'no_response') counts.pending++;
      else counts.invalid++;
    }
    this.emit({ kind: 'outcomes', counts });
    this.closed = true;
  }
}
