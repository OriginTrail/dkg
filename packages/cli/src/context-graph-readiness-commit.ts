// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  writeContextGraphReadiness,
  type ContextGraphReadinessStore,
  type ContextGraphSubscriptionStatePatch,
} from './context-graph-readiness.js';
import type { ContextGraphReadinessPatch } from './context-graph-readiness-policy.js';

/** Apply one classifier decision without an await between its two stores. */
export function commitContextGraphReadinessPatches(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  statePatch?: ContextGraphSubscriptionStatePatch;
  readinessPatch?: ContextGraphReadinessPatch;
}): void {
  if (input.readinessPatch) {
    writeContextGraphReadiness(input.store, input.contextGraphId, input.readinessPatch);
  }
  if (input.statePatch) {
    input.agent.markContextGraphSubscriptionState(input.contextGraphId, input.statePatch);
  }
}
