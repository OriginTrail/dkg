import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGEvent } from '@origintrail-official/dkg-core';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import type { CatchupRunner } from '../catchup-runner.js';
import {
  hasAuthoritativeContextGraphMetadata,
  readContextGraphReadiness,
  writeContextGraphReadiness,
} from '../context-graph-readiness.js';
import { ContextGraphCatchupCoordinatorService } from './context-graph-catchup-coordinator.js';
import type { CatchupTracker } from './types.js';

/**
 * Bind daemon-owned persistence, agent, and event effects once at the route
 * boundary. The subscribe route only chooses a scope and delegates
 * start/coalescing; readiness classification and side effects stay behind the
 * coordinator's narrow API.
 */
export function createContextGraphCatchupRouteAdapter(input: {
  tracker: CatchupTracker;
  runner: Pick<CatchupRunner, 'run'>;
  readinessStore: DashboardDB;
  agent: DKGAgent;
  trace?: (message: string) => void;
}): ContextGraphCatchupCoordinatorService {
  return new ContextGraphCatchupCoordinatorService(input.tracker, {
    runner: input.runner,
    readReadiness: (contextGraphId) =>
      readContextGraphReadiness(input.readinessStore, contextGraphId),
    hasConfirmedMeta: (contextGraphId) =>
      hasAuthoritativeContextGraphMetadata({
        agent: input.agent,
        contextGraphId,
      }),
    isPrivate: (contextGraphId) =>
      input.agent.isPrivateContextGraph(contextGraphId).catch(() => true),
    writeReadiness: (contextGraphId, patch) =>
      writeContextGraphReadiness(input.readinessStore, contextGraphId, patch),
    markSubscriptionState: (contextGraphId, patch) =>
      input.agent.markContextGraphSubscriptionState(contextGraphId, patch),
    emitProjectSynced: (contextGraphId, payload) => {
      input.agent.eventBus?.emit?.(DKGEvent.PROJECT_SYNCED, {
        contextGraphId,
        ...payload,
      });
    },
    ...(input.trace ? { trace: input.trace } : {}),
  });
}
