import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RuntimeAdapterOperation, SemanticN8nConfig, SemanticN8nGrant } from '@origintrail-official/dkg-semantic-runtime';
import { assertN8nValue, n8nExecutionMatches, n8nRecord, n8nWorkflowSha256, validateN8nConfig, validateN8nGrant } from './semantic-runtime-n8n-contract.js';

class N8nDispatchError extends Error {
  constructor(readonly mayHaveExecuted: boolean, code: string) { super(code); }
}

function token(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.length > 8192) throw new Error('N8N_CREDENTIAL_UNAVAILABLE');
  const value = bytes.toString('utf8').trim();
  if (value.length < 16 || /[\r\n]/.test(value)) throw new Error('N8N_CREDENTIAL_UNAVAILABLE');
  return value;
}

async function json(url: URL, headers: Record<string, string>, body?: unknown, signal = AbortSignal.timeout(10_000)): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('N8N_REQUEST_FAILED'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 1_048_576) throw new Error('N8N_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!n8nRecord(value)) throw new Error('N8N_RESPONSE_INVALID');
    return value;
  } finally { await reader.cancel().catch(() => {}); }
}

/** Installed only for bound TypeScript calls; uses the common durable effect broker. */
export function createN8nWorkflowAdapter(
  graph: string, executor: string, approved: SemanticN8nGrant,
  installation: SemanticN8nConfig | undefined, assertAuthorized: () => Promise<void>,
): RuntimeAdapterOperation<unknown, string> {
  validateN8nGrant(approved);
  const grant = structuredClone(approved);
  const configuration = installation ? JSON.stringify(installation) : '';
  const matches = () => {
    if (!installation || JSON.stringify(installation) !== configuration) return false;
    validateN8nConfig(installation);
    return installation.workflows.some(item => item.contextGraphId === graph
      && item.executorAgentAddress.toLowerCase() === executor.toLowerCase()
      && item.workflowId === grant.workflowId && item.workflowSha256 === grant.workflowSha256);
  };
  return {
    id: 'n8n/workflow', version: '1', witInterface: 'origintrail:semantic-runtime/n8n-workflow@0.1.0',
    implementationVersion: 'n8n-workflow-poc-v1',
    implementationHash: createHash('sha256').update(readFileSync(new URL(import.meta.url)))
      .update(configuration).update(JSON.stringify(grant)).digest('hex'),
    enabled: matches, effectClass: 'external-workflow', verb: 'invoke',
    idempotencyClass: 'non_repeatable', reconciliationRule: 'inspect-n8n-execution-without-repeating-dispatch',
    validateInput(input) { assertN8nValue(grant.inputSchema, input, 'INPUT'); return structuredClone(input); },
    async dispatch(authorization, input) {
      let mayHaveExecuted = false;
      try {
        assertN8nValue(grant.inputSchema, input, 'INPUT');
        await assertAuthorized();
        if (!matches()) throw new Error('N8N_WORKFLOW_NOT_INSTALLED');
        const deadline = AbortSignal.timeout(15_000);
        const origin = new URL(installation!.baseUrl);
        const apiHeaders = { 'X-N8N-API-KEY': token(installation!.apiTokenFile) };
        const workflow = await json(new URL(`/api/v1/workflows/${grant.workflowId}`, origin), apiHeaders, undefined, deadline);
        const published = n8nRecord(workflow.activeVersion) ? { ...workflow.activeVersion, settings: workflow.settings } : workflow;
        if (workflow.id !== grant.workflowId || workflow.active !== true || typeof published.versionId !== 'string'
          || !published.versionId || n8nWorkflowSha256(published) !== grant.workflowSha256) {
          throw new Error('N8N_WORKFLOW_NOT_PINNED');
        }
        const webhookHeaders = { authorization: `Bearer ${token(installation!.webhookTokenFile)}` };
        await assertAuthorized();
        if (!matches()) throw new Error('N8N_WORKFLOW_NOT_INSTALLED');
        mayHaveExecuted = true;
        const response = await json(new URL(`/webhook/dkg-capability-${grant.workflowId}`, origin), webhookHeaders,
          { invocationId: authorization.effectId, input }, deadline);
        if (typeof response.executionId !== 'string' || !/^\d{1,20}$/.test(response.executionId)
          || Object.keys(response).some(key => !['executionId', 'output'].includes(key))) throw new Error('N8N_RESPONSE_INVALID');
        assertN8nValue(grant.outputSchema, response.output, 'OUTPUT');
        // Verify the definition actually used, including edits between preflight and dispatch.
        let execution = await json(new URL(`/api/v1/executions/${response.executionId}?includeData=true`, origin), apiHeaders, undefined, deadline);
        for (let attempt = 0; execution.status === 'running' && attempt < 20; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          await assertAuthorized();
          execution = await json(new URL(`/api/v1/executions/${response.executionId}?includeData=true`, origin), apiHeaders, undefined, deadline);
        }
        if (String(execution.id) !== response.executionId || execution.workflowId !== grant.workflowId || execution.status !== 'success'
          || !n8nRecord(execution.workflowData) || execution.workflowVersionId !== published.versionId
          || !n8nExecutionMatches(published, execution.workflowData)) throw new Error('N8N_EXECUTION_NOT_VERIFIED');
        await assertAuthorized();
        if (!matches()) throw new Error('N8N_WORKFLOW_NOT_INSTALLED');
        const output = JSON.stringify({ kind: 'n8n-result', workflowId: grant.workflowId, workflowSha256: grant.workflowSha256,
          n8nExecutionId: response.executionId, output: response.output });
        return { status: 'succeeded', output,
          evidenceRef: 'urn:sr:n8n-execution:' + response.executionId + ':' + createHash('sha256').update(output).digest('hex') };
      } catch (error) {
        const code = error instanceof Error && /^((INVALID|N8N)_[A-Z0-9_]+)$/.test(error.message) ? error.message : 'N8N_INVOCATION_FAILED';
        throw new N8nDispatchError(mayHaveExecuted, code);
      }
    },
    reconcile: async () => ({ status: 'unknown', evidenceRef: 'urn:sr:n8n:execution-inspection-required' }),
    couldHaveReachedTarget: error => !(error instanceof N8nDispatchError) || error.mayHaveExecuted,
  };
}
