import type { ACKCandidateCounts } from './ack-peer-status-ledger.js';

export type ACKDiagnosticEvent =
  | { kind: 'attempt_started'; active: number }
  | { kind: 'attempt'; durationMs: number }
  | { kind: 'backoff'; durationMs: number; reason: 'transport' | 'transient_decline' }
  | { kind: 'outcomes'; counts: ACKCandidateCounts };

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

  finish(counts: ACKCandidateCounts): void {
    this.emit({ kind: 'outcomes', counts });
    this.closed = true;
  }
}
