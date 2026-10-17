import type { ACKCandidateCounts } from './ack-peer-status-ledger.js';

/** One terminal snapshot owned by the publisher; no peer, graph or payload fields. */
export interface ACKDiagnosticSummary {
  readonly completedPeerAttempts: number;
  readonly perRoundPeakPeerRequests: number;
  readonly peerAttemptMs: number;
  readonly backoffs: number;
  readonly backoffMs: number;
  readonly transportBackoffs: number;
  readonly transientDeclineBackoffs: number;
  readonly candidates: Readonly<ACKCandidateCounts>;
}

export class ACKRoundDiagnostics {
  private closed = false;
  private active = 0;
  private attempts = 0;
  private peakPeerRequests = 0;
  private attemptMs = 0;
  private backoffs = 0;
  private backoffMs = 0;
  private transportBackoffs = 0;
  private transientDeclineBackoffs = 0;
  constructor(private readonly observer?: (summary: ACKDiagnosticSummary) => void,
    private readonly now = () => performance.now()) {}

  async measure<T>(kind: 'attempt' | 'backoff', work: () => Promise<T>, reason: 'transport' | 'transient_decline' = 'transport'): Promise<T> {
    const started = this.now();
    const tracked = !this.closed;
    if (tracked && kind === 'attempt') this.peakPeerRequests = Math.max(this.peakPeerRequests, ++this.active);
    try { return await work(); } finally {
      if (tracked && kind === 'attempt') this.active--;
      if (!this.closed) {
        const durationMs = Math.max(0, this.now() - started);
        if (kind === 'attempt') { this.attempts++; this.attemptMs += durationMs; }
        else {
          this.backoffs++; this.backoffMs += durationMs;
          if (reason === 'transport') this.transportBackoffs++; else this.transientDeclineBackoffs++;
        }
      }
    }
  }

  finish(counts: ACKCandidateCounts): void {
    if (this.closed) return;
    this.closed = true;
    const summary: ACKDiagnosticSummary = Object.freeze({
      completedPeerAttempts: this.attempts, perRoundPeakPeerRequests: this.peakPeerRequests,
      peerAttemptMs: this.attemptMs, backoffs: this.backoffs, backoffMs: this.backoffMs,
      transportBackoffs: this.transportBackoffs, transientDeclineBackoffs: this.transientDeclineBackoffs,
      candidates: Object.freeze({ ...counts }),
    });
    try { this.observer?.(summary); } catch { /* observability cannot change ACK decisions */ }
  }
}
