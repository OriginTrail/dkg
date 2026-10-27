import type { AgentGraphOwnedRecoveryRequest } from '../../src/durable-recovery-owned-round.js';
import type { DKGAgent } from '../../src/dkg-agent.js';

/** Model an admitted legacy operation at both the public and graph-owned execution seams. */
export function stubDurableSync(
  agent: Pick<DKGAgent, 'syncFromPeerDetailed'>,
  sync: DKGAgent['syncFromPeerDetailed'],
): void {
  Object.assign(agent, {
    syncFromPeerDetailed: sync,
    canUseLegacyDurableSyncForContextGraphV1: async () => true,
    runGraphOwnedDurableRecoveryRound: async (request: AgentGraphOwnedRecoveryRequest) => ({
      result: await sync(request.remotePeerId, [request.contextGraphId], undefined, undefined, undefined, request.options),
      decision: { strategy: 'legacy' },
    }),
    runLegacyDurableSyncDetailed: async (_ctx: unknown, ...args: Parameters<typeof sync>) => ({
      result: await sync(...args), recoveryRound: { strategy: 'legacy' },
    }),
  });
}
