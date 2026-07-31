import {
  Logger,
  type OperationContext,
} from './logger.js';
import { getMetrics } from './telemetry-api.js';

export type SyncPlane = 'vm' | 'swm';
export type SyncTrigger = 'foreground' | 'background' | 'subscription' | 'post-approval';
export type SyncPlaneOutcome =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'deferred'
  | 'denied'
  | 'unreachable';

export interface SyncPlaneEvidence {
  verified: boolean;
  /** Whether the graph's authoritative scope/metadata was verified this run. */
  authoritativeScopeConfirmed?: boolean;
  connectedPeers: number;
  syncCapablePeers: number;
  peersTried: number;
  peersResponded: number;
  deferredBackpressure?: number;
  deniedPhases?: number;
  timedOutPhases?: number;
}

/**
 * Convert final plane evidence into one bounded operator outcome. Success is
 * deliberately only reachable through a caller-provided verification proof;
 * fetched/inserted triple counts alone never count as success.
 */
export function classifySyncPlaneOutcome(
  evidence: SyncPlaneEvidence,
): SyncPlaneOutcome {
  if (evidence.verified) return 'success';
  if ((evidence.deniedPhases ?? 0) > 0) return 'denied';
  if ((evidence.deferredBackpressure ?? 0) > 0) return 'deferred';
  if ((evidence.timedOutPhases ?? 0) > 0) return 'timeout';
  if (
    evidence.authoritativeScopeConfirmed === false
    ||
    evidence.connectedPeers === 0
    || evidence.syncCapablePeers === 0
    || evidence.peersTried === 0
    || evidence.peersResponded === 0
  ) return 'unreachable';
  return 'failed';
}

export interface SyncPlaneTerminalDetails {
  triplesSynced?: number;
  errorCode?: string;
}

export interface SyncAttemptObserverOptions {
  logger: Logger;
  context: OperationContext;
  contextGraphId: string;
  trigger: SyncTrigger;
  planes: readonly SyncPlane[];
  now?: () => number;
}

const DEFAULT_ERROR_CODE: Record<Exclude<SyncPlaneOutcome, 'success'>, string> = {
  failed: 'SYNC_PLANE_FAILED',
  timeout: 'SYNC_PLANE_TIMEOUT',
  deferred: 'SYNC_PLANE_DEFERRED',
  denied: 'SYNC_PLANE_DENIED',
  unreachable: 'SYNC_PLANE_UNREACHABLE',
};

const RETRYABLE: Record<SyncPlaneOutcome, boolean> = {
  success: false,
  failed: true,
  timeout: true,
  deferred: true,
  denied: false,
  unreachable: true,
};

/**
 * Process-local exactly-once recorder for one logical sync job. Each requested
 * plane gets one start and at most one terminal event, regardless of peers or
 * pages involved in the transfer.
 */
export class SyncAttemptObserver {
  private readonly startedAt: number;
  private readonly pending: Set<SyncPlane>;
  private readonly now: () => number;

  constructor(private readonly options: SyncAttemptObserverOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.pending = new Set(options.planes);
    for (const plane of this.pending) {
      const attrs = { plane, trigger: options.trigger };
      getMetrics().syncPlaneStartedTotal.add(1, attrs);
      getMetrics().syncPlaneActive.add(1, attrs);
    }
  }

  finish(
    plane: SyncPlane,
    outcome: SyncPlaneOutcome,
    details: SyncPlaneTerminalDetails = {},
  ): boolean {
    if (!this.pending.delete(plane)) return false;

    const durationMs = Math.max(0, this.now() - this.startedAt);
    const metricAttrs = { plane, trigger: this.options.trigger, outcome };
    getMetrics().syncPlaneTerminalTotal.add(1, metricAttrs);
    getMetrics().syncPlaneDurationMs.record(durationMs, metricAttrs);
    getMetrics().syncPlaneActive.add(-1, {
      plane,
      trigger: this.options.trigger,
    });

    const semantic = {
      eventCode: 'sync.plane.terminal',
      component: 'sync',
      outcome,
      retryable: RETRYABLE[outcome],
      ...(outcome === 'success'
        ? {}
        : { errorCode: details.errorCode ?? DEFAULT_ERROR_CODE[outcome] }),
      syncPlane: plane,
      syncTrigger: this.options.trigger,
      durationMs,
      triplesSynced: Math.max(0, details.triplesSynced ?? 0),
    } as const;
    const message = `Sync plane ${plane.toUpperCase()} for "${this.options.contextGraphId}" reached terminal outcome=${outcome} durationMs=${durationMs} triplesSynced=${semantic.triplesSynced}`;

    if (outcome === 'success') {
      this.options.logger.info(this.options.context, message, semantic);
    } else if (outcome === 'failed') {
      this.options.logger.error(this.options.context, message, semantic);
    } else {
      this.options.logger.warn(this.options.context, message, semantic);
    }
    return true;
  }

  finishRemaining(
    outcome: Exclude<SyncPlaneOutcome, 'success'>,
    details: SyncPlaneTerminalDetails = {},
  ): void {
    for (const plane of [...this.pending]) this.finish(plane, outcome, details);
  }
}
