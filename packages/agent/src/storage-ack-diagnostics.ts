import type { ACKDiagnosticSummary } from '@origintrail-official/dkg-publisher';
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import type { StorageACKAdmission, StorageACKAdmissionEvent } from './storage-ack-admission.js';

/** One bounded aggregate per round: no graph, peer, payload, or credential fields. */
export class StorageACKDiagnostics {
  private readonly started: number;
  private queuedAt: number | undefined;
  private acquiredAt: number | undefined;
  private releasedAt: number | undefined;
  private preflightMs: number | undefined;
  private waitMs = 0;
  private workMs = 0;
  private queued = 0;
  private active = 0;
  private outcome: 'preflight_failed' | 'failed' | 'cancelled' | 'succeeded' = 'preflight_failed';
  private collectorSummary: ACKDiagnosticSummary = {
    completedPeerAttempts: 0, perRoundPeakPeerRequests: 0, peerAttemptMs: 0,
    backoffs: 0, backoffMs: 0, transportBackoffs: 0, transientDeclineBackoffs: 0,
    candidates: { total: 0, ack: 0, declined: 0, invalid: 0, unsupported: 0, transport: 0, pending: 0 },
  };

  constructor(private readonly operation: 'publish' | 'update', private readonly log: (message: string) => void,
    private readonly now = () => performance.now()) { this.started = now(); }

  preflightComplete(): void { this.preflightMs = this.now() - this.started; this.outcome = 'failed'; }
  succeeded(): void { this.outcome = 'succeeded'; }
  readonly admission = (event: StorageACKAdmissionEvent): void => {
    if (event.stage === 'queued') this.queuedAt = this.now() - this.started;
    if (event.stage === 'acquired') this.acquiredAt = this.now() - this.started;
    if (event.stage === 'released') this.releasedAt = this.now() - this.started;
    this.queued = Math.max(this.queued, event.queued);
    this.active = Math.max(this.active, event.active);
    this.waitMs = Math.max(this.waitMs, event.waitMs);
    if (event.stage === 'released') this.workMs = event.workMs;
    if (event.stage === 'cancelled') this.outcome = 'cancelled';
  };
  readonly collector = (summary: ACKDiagnosticSummary): void => { this.collectorSummary = summary; };
  finish(signal?: AbortSignal): void {
    const totalMs = this.now() - this.started;
    const round = (value: number) => Math.round(Math.max(0, value) * 1000) / 1000;
    try {
      this.log(`[StorageACKAdmission] ${JSON.stringify({ operation: this.operation,
        outcome: signal?.aborted ? 'cancelled' : this.outcome,
        preflightMs: round(this.preflightMs ?? totalMs), gateWaitMs: round(this.waitMs),
        gateQueuedAfterMs: this.queuedAt === undefined ? null : round(this.queuedAt),
        gateAcquiredAfterMs: this.acquiredAt === undefined ? null : round(this.acquiredAt),
        gateReleasedAfterMs: this.releasedAt === undefined ? null : round(this.releasedAt),
        collectorMs: round(this.workMs), totalMs: round(totalMs), maxQueued: this.queued, maxActive: this.active,
        ...this.collectorSummary,
        peerAttemptMs: round(this.collectorSummary.peerAttemptMs),
        backoffMs: round(this.collectorSummary.backoffMs) })}`);
    } catch { /* diagnostics must not change the publication outcome */ }
  }
}


type Admit = <T>(collect: (observe: (summary: ACKDiagnosticSummary) => void) => Promise<T>) => Promise<T>;

/** Capture the lifetime before preflight; drain physical work before store teardown. */
export function runStorageACKOperation<T>(
  lifetime: AgentWorkLifetime, gate: StorageACKAdmission, operation: 'publish' | 'update',
  log: (message: string) => void, work: (admit: Admit) => Promise<T>,
): Promise<T> {
  const signal = lifetime.signal;
  const diagnostics = new StorageACKDiagnostics(operation, log);
  const run = (async () => {
    try {
      signal.throwIfAborted();
      const result = await work(collect => {
        diagnostics.preflightComplete();
        return gate.run(() => collect(diagnostics.collector), signal, diagnostics.admission);
      });
      signal.throwIfAborted();
      diagnostics.succeeded();
      return result;
    } finally { diagnostics.finish(signal); }
  })();
  return lifetime.track(run);
}
