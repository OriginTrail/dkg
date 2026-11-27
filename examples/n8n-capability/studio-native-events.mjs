import { n8nObservationScope, n8nPinnedExecutionMatches } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

/** Yield verified native timer inputs; Studio owns authorization, reservation and execution. */
export async function* nativeTimerEvents(api, { graphId, owner, grant, startedAt, pendingExecutionIds }) {
  const workflowId = grant.workflowId;
  const native = await api('/workflows/' + workflowId);
  if (native.id !== workflowId || native.active !== true) return;
  const published = { ...native.activeVersion, settings: native.settings };
  const page = await api('/executions?limit=20&workflowId=' + encodeURIComponent(workflowId));
  const candidates = new Set(page.data.map(execution => String(execution.id)));
  // Pending identities remain inspectable after leaving the latest provider page.
  for (const executionId of pendingExecutionIds) candidates.add(executionId);
  const scope = n8nObservationScope(graphId, owner, workflowId) + ' trigger';
  for (const executionId of [...candidates].reverse()) {
    if (!/^\d{1,20}$/.test(executionId)) continue;
    const detail = await api('/executions/' + executionId + '?includeData=true');
    const runs = detail.data?.resultData?.runData?.[scope];
    if (String(detail.id) !== executionId || detail.status !== 'success'
      || !Number.isFinite(Date.parse(detail.startedAt)) || Date.parse(detail.startedAt) < startedAt
      || !Array.isArray(runs) || !runs.length
      || !n8nPinnedExecutionMatches(published, detail, grant, published.versionId)) continue;
    yield { executionId, items: runs.at(-1).data.main[0].map(item => item.json) };
  }
}
