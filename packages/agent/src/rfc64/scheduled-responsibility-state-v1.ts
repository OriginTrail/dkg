// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '../dkg-agent.js';

export interface Rfc64ScheduledFinalizedAbsenceRetryV1 {
  readonly contextGraphId: string;
  readonly revision: number;
  readonly attempt: number;
  readonly delayMs: number;
  /** Unique ownership key; attempt identity must never be reconstructed by callers. */
  readonly key: string;
}
export interface Rfc64ScheduledResponsibilityStateV1 {
  readonly targets: Map<string, number>;
  readonly activeTargets: Set<string>;
  readonly finalizedAbsenceRetries: Map<
    string,
    Readonly<Rfc64ScheduledFinalizedAbsenceRetryV1>
  >;
  activityRevision: number;
  producerHolds: number;
}
const rfc64ScheduledResponsibilityStatesV1 =
  new WeakMap<DKGAgent, Rfc64ScheduledResponsibilityStateV1>();
export function rfc64ScheduledResponsibilityStateForV1(
  agent: DKGAgent,
): Rfc64ScheduledResponsibilityStateV1 {
  let state = rfc64ScheduledResponsibilityStatesV1.get(agent);
  if (state === undefined) {
    state = {
      targets: new Map(),
      activeTargets: new Set(),
      finalizedAbsenceRetries: new Map(),
      activityRevision: 0,
      producerHolds: 0,
    };
    rfc64ScheduledResponsibilityStatesV1.set(agent, state);
  }
  return state;
}

