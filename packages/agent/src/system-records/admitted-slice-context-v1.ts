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
