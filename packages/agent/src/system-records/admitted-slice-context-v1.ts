// SPDX-License-Identifier: Apache-2.0

declare const AGENT_PROFILE_ADMITTED_SLICE_CONTEXT_V1: unique symbol;

/**
 * Opaque lifecycle-owned authority for one nonrenewable admitted physical slice.
 * The concrete admission implementation owns runtime authentication and the clock.
 */
export interface AgentProfileAdmittedSliceContextV1 {
  readonly [AGENT_PROFILE_ADMITTED_SLICE_CONTEXT_V1]: 'agent-profile-admitted-slice-context-v1';
}

export interface AgentProfileAdmittedSliceSnapshotV1 {
  /** Current time from the same monotonic clock that minted the context. */
  readonly nowMs: number;
  /** Original absolute deadline; inspection must never refresh it. */
  readonly admittedDeadlineMs: number;
}

/** Canonical lifecycle-owned minting and authentication boundary for slice tokens. */
export interface AgentProfileAdmittedSliceContextAuthorityV1 {
  mint(admittedDeadlineMs: number): AgentProfileAdmittedSliceContextV1;
  inspect(
    context: AgentProfileAdmittedSliceContextV1,
  ): AgentProfileAdmittedSliceSnapshotV1;
  revoke(context: AgentProfileAdmittedSliceContextV1): void;
}

/**
 * Create one isolated authority domain. The private cast and token registry live
 * here so admission implementations never fabricate the opaque brand.
 */
export function createAgentProfileAdmittedSliceContextAuthorityV1(
  nowMs: () => number,
): AgentProfileAdmittedSliceContextAuthorityV1 {
  if (typeof nowMs !== 'function') {
    throw new TypeError('agent-profile admitted slice clock must be a function');
  }
  const deadlines = new WeakMap<object, number>();

  return Object.freeze({ mint, inspect, revoke });

  function mint(admittedDeadlineMs: number): AgentProfileAdmittedSliceContextV1 {
    if (!Number.isSafeInteger(admittedDeadlineMs) || admittedDeadlineMs < 0) {
      throw new Error('agent-profile admitted slice deadline is invalid');
    }
    const context = Object.freeze(
      Object.create(null),
    ) as AgentProfileAdmittedSliceContextV1;
    deadlines.set(context, admittedDeadlineMs);
    return context;
  }

  function inspect(
    context: AgentProfileAdmittedSliceContextV1,
  ): AgentProfileAdmittedSliceSnapshotV1 {
    const admittedDeadlineMs = deadlines.get(context);
    if (admittedDeadlineMs === undefined) {
      throw new Error('agent-profile admitted slice context is invalid or revoked');
    }
    return Object.freeze({ nowMs: readNow(), admittedDeadlineMs });
  }

  function revoke(context: AgentProfileAdmittedSliceContextV1): void {
    deadlines.delete(context);
  }

  function readNow(): number {
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('agent-profile admitted slice clock is invalid');
    }
    return now;
  }
}
