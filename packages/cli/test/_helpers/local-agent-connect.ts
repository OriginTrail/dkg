import type { DkgConfig } from '../../src/config.js';
import {
  connectLocalAgentIntegration,
  getLocalAgentIntegration,
  type LocalAgentConnectPlan,
  type LocalAgentAttachJobHandle,
  type LocalAgentIntegrationRecord,
  updateLocalAgentIntegration,
} from '../../src/daemon/local-agents.js';

/** Apply the same commit → afterCommit sequence as the daemon route. */
export function commitLocalAgentConnectPlanForTest(
  config: DkgConfig,
  id: string,
  plan: LocalAgentConnectPlan,
): {
  integration: LocalAgentIntegrationRecord;
  notice?: string;
  attachJob?: LocalAgentAttachJobHandle;
} {
  connectLocalAgentIntegration(config, { ...plan.state, id });
  const afterCommit = plan.ok ? plan.afterCommit?.({
    current: () => config,
    persist: async (patch) => { updateLocalAgentIntegration(config, id, patch); },
  }) : undefined;
  return {
    integration: getLocalAgentIntegration(config, id)!,
    notice: afterCommit?.notice ?? plan.notice,
    attachJob: afterCommit?.attachJob,
  };
}

export function commitLocalAgentRefreshPatchForTest(
  config: DkgConfig,
  id: string,
  patch: Parameters<typeof updateLocalAgentIntegration>[2],
): LocalAgentIntegrationRecord {
  return updateLocalAgentIntegration(config, id, patch);
}
