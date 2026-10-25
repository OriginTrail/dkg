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

export type ACKBackoffReason = 'transport' | 'transient_decline';

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

  async measureAttempt<T>(work: () => Promise<T>): Promise<T> {
    const started = this.now();
    const tracked = !this.closed;
    if (tracked) this.peakPeerRequests = Math.max(this.peakPeerRequests, ++this.active);
    try { return await work(); } finally {
      if (tracked) this.active--;
      if (!this.closed) {
        this.attempts++;
        this.attemptMs += Math.max(0, this.now() - started);
      }
    }
  }

  async measureBackoff<T>(reason: ACKBackoffReason, work: () => Promise<T>): Promise<T> {
    const started = this.now();
    try { return await work(); } finally {
      if (!this.closed) {
        this.backoffs++;
        this.backoffMs += Math.max(0, this.now() - started);
        if (reason === 'transport') this.transportBackoffs++;
        else this.transientDeclineBackoffs++;
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
