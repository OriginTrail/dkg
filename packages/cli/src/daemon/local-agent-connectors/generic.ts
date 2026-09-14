import { cancelPending } from '../local-agent-attach-jobs.js';
import type { LocalAgentConnectorStrategy } from './types.js';

/** Default lifecycle for registry-only integrations without adapter teardown. */
export function createGenericConnector(): LocalAgentConnectorStrategy {
  return {
    createPlan: async ({ requested }) => ({
      ok: true,
      state: {},
      notice: `${requested.name} was registered. Chat will appear here once its framework bridge is available.`,
    }),
    cancelPending,
    createDisconnectPlan: async ({ state }) => ({ state }),
  };
}
