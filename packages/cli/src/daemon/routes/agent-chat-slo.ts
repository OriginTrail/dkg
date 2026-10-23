import { DKGAgent } from '@origintrail-official/dkg-agent';

/**
 * Build the `/api/slo` response payload. Extracted out of the inline
 * route block so the public wire shape is testable in isolation
 * (rc.9 PR-A / Codex PR #570 R10) — production route + regression
 * test share the exact same code path, so a future drift in any
 * field name / nesting can't slip past CI.
 *
 * Cold-start safety: when `sharedMemoryHandler` has never been
 * instantiated (no SWM share has ever been received), the agent's
 * `getSwmHandlerStats()` returns its pristine snapshot rather than
 * throwing — `buildSloPayload` is safe to call against a fresh
 * daemon.
 */
export function buildSloPayload(agent: {
  getMessengerSloStats: () => Record<string, unknown>;
  getMessengerOutboxStats?: DKGAgent['getMessengerOutboxStats'];
  getSwmGossipStats: () => {
    publishFailures: Record<string, number>;
    publishFailuresOverflow: number;
    publishFailuresTruncated: boolean;
  };
  getSwmHandlerStats: () => {
    redundantApplies: Record<string, number>;
    redundantAppliesLowerBound: boolean;
    redundantAppliesOverflow: number;
    redundantAppliesTruncated: boolean;
  };
  /**
   * rc.9 PR-C addition. Optional on the interface so a hypothetical
   * test double that only exercises the gossip + receiver sides
   * doesn't have to stub it. Implementations that omit it simply
   * leave `swm.substrateFanout` off the response — soak scripts
   * check for its presence before referencing fields.
   */
  getSwmSubstrateFanoutStats?: () => {
    delivered: Record<string, number>;
    rejected: Record<string, number>;
    /**
     * rc.9 PR-D (codex follow-up from PR-G #G1): transient
     * receiver-side rejections. Optional on the interface for
     * back-compat with pre-PR-D test doubles.
     */
    retryable?: Record<string, number>;
    queued: Record<string, number>;
    inFlight: Record<string, number>;
    failed: Record<string, number>;
    overflow: {
      delivered: number;
      rejected: number;
      retryable?: number;
      queued: number;
      inFlight: number;
      failed: number;
    };
    truncated: boolean;
  };
  /**
   * rc.9 PR-D addition. Optional for the same reason
   * getSwmSubstrateFanoutStats is — test doubles don't need to
   * stub a tracker they aren't exercising.
   */
  getSwmAckQuorumStats?: () => {
    tracked: number;
    completed: number;
    watchdogFired: number;
    deadlineExpired: number;
    pending: number;
  };
}): {
  protocols: Record<string, unknown>;
  outbox?: ReturnType<DKGAgent['getMessengerOutboxStats']>;
  gossip: {
    publishFailures: Record<string, number>;
    publishFailuresOverflow: number;
    publishFailuresTruncated: boolean;
  };
  swm: {
    redundantApplies: Record<string, number>;
    redundantAppliesLowerBound: boolean;
    redundantAppliesOverflow: number;
    redundantAppliesTruncated: boolean;
    /**
     * rc.9 PR-C: substrate fan-out per-outcome counters. Present
     * iff the agent exposes `getSwmSubstrateFanoutStats()` (every
     * production agent does; opt-out is for test doubles).
     */
    substrateFanout?: {
      delivered: Record<string, number>;
      rejected: Record<string, number>;
      retryable?: Record<string, number>;
      queued: Record<string, number>;
      inFlight: Record<string, number>;
      failed: Record<string, number>;
      overflow: {
        delivered: number;
        rejected: number;
        retryable?: number;
        queued: number;
        inFlight: number;
        failed: number;
      };
      truncated: boolean;
    };
    /**
     * rc.9 PR-D: ack-quorum overlay counters. Same opt-out
     * mechanic as `substrateFanout` — present iff the agent
     * exposes `getSwmAckQuorumStats()`.
     */
    shareAckQuorum?: {
      tracked: number;
      completed: number;
      watchdogFired: number;
      deadlineExpired: number;
      pending: number;
    };
  };
} {
  const swmHandler = agent.getSwmHandlerStats();
  const substrateFanout = agent.getSwmSubstrateFanoutStats?.();
  const shareAckQuorum = agent.getSwmAckQuorumStats?.();
  const outbox = agent.getMessengerOutboxStats?.();
  return {
    protocols: agent.getMessengerSloStats(),
    ...(outbox !== undefined ? { outbox } : {}),
    gossip: agent.getSwmGossipStats(),
    swm: {
      ...swmHandler,
      ...(substrateFanout !== undefined ? { substrateFanout } : {}),
      ...(shareAckQuorum !== undefined ? { shareAckQuorum } : {}),
    },
  };
}
