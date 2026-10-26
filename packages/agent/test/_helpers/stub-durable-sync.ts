import type { DKGAgent } from '../../src/dkg-agent.js';

/** Model an admitted legacy operation at both the public and graph-owned execution seams. */
export function stubDurableSync(
  agent: Pick<DKGAgent, 'syncFromPeerDetailed'>,
  sync: DKGAgent['syncFromPeerDetailed'],
): void {
  Object.assign(agent, {
    syncFromPeerDetailed: sync,
    canUseLegacyDurableSyncForContextGraphV1: async () => true,
    runLegacyDurableSyncDetailed: async (_ctx: unknown, ...args: Parameters<typeof sync>) => ({
      result: await sync(...args), recoveryRound: { strategy: 'full', continuation: 'full-graph', confirmedCopies: 0 },
    }),
  });
}
