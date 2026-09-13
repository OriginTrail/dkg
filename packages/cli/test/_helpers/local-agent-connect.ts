import type { DkgConfig } from '../../src/config.js';
import {
  connectLocalAgentIntegration,
  getLocalAgentIntegration,
  type LocalAgentConnectPlan,
  type LocalAgentIntegrationRecord,
  updateLocalAgentIntegration,
} from '../../src/daemon/local-agents.js';

/** Apply the same commit → afterCommit sequence as the daemon route. */
export function commitLocalAgentConnectPlanForTest(
  config: DkgConfig,
  id: string,
  plan: LocalAgentConnectPlan,
): { integration: LocalAgentIntegrationRecord; notice?: string } {
  connectLocalAgentIntegration(config, { ...plan.state, id });
  const afterCommitNotice = plan.ok ? plan.afterCommit?.({
    current: () => config,
    persist: async (patch) => { updateLocalAgentIntegration(config, id, patch); },
  }) : undefined;
  return {
    integration: getLocalAgentIntegration(config, id)!,
    notice: afterCommitNotice ?? plan.notice,
  };
}

export function commitLocalAgentRefreshPatchForTest(
  config: DkgConfig,
  id: string,
  patch: Parameters<typeof updateLocalAgentIntegration>[2],
): LocalAgentIntegrationRecord {
  return updateLocalAgentIntegration(config, id, patch);
}
