import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RuntimeAdapterOperation, SemanticN8nConfig, SemanticN8nGrant, SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { assertN8nValue, n8nExecutionMatches, n8nObservationScope, n8nRecord, n8nWorkflowSha256, validateN8nConfig, validateN8nGrant } from './semantic-runtime-n8n-contract.js';
import { collectN8nExecutionResult } from './semantic-runtime-n8n-results.js';

type Checkpoint = { kind: 'n8n-native-v1'; workflowId: string; workflowSha256: string; executionId: string; versionId: string; observed: boolean };
type PreparedEffectToken = Parameters<RuntimeAdapterOperation['dispatch']>[0];
class NativeError extends Error {
  constructor(readonly mayHaveExecuted: boolean, code: string) { super(code); }
}
const secret = (path: string): string => {
  const bytes = readFileSync(path);
  const value = bytes.toString('utf8').trim();
  if (bytes.length > 8192 || value.length < 16 || /[\r\n]/.test(value)) throw new Error('N8N_CREDENTIAL_UNAVAILABLE');
  return value;
};
async function request(url: URL, headers: Record<string, string>, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('N8N_REQUEST_FAILED'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1_048_576) throw new Error('N8N_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!n8nRecord(value)) throw new Error('N8N_RESPONSE_INVALID');
    return value;
  } finally { await reader.cancel().catch(() => {}); }
}

/** Early acknowledgement + durable provider execution ID; continuation never POSTs again. */
export function createNativeN8nWorkflowAdapter(
  graph: string, executor: string, approved: SemanticN8nGrant,
  installation: SemanticN8nConfig | undefined, assertAuthorized: () => Promise<void>, store: SemanticRuntimeStore,
): RuntimeAdapterOperation<unknown, string> {
  validateN8nGrant(approved);
  if (!approved.result) throw new Error('INVALID_N8N_GRANT');
  const grant = structuredClone(approved);
  const selectedConfiguration = () => installation && ({ ...installation, workflows: installation.workflows.filter(item =>
    item.contextGraphId === graph && item.executorAgentAddress.toLowerCase() === executor.toLowerCase() && item.workflowId === grant.workflowId) });
  const configuration = JSON.stringify(selectedConfiguration());
  const matches = () => {
    if (!installation || configuration !== JSON.stringify(selectedConfiguration())) return false;
    validateN8nConfig(installation);
    return installation.workflows.some(item => item.contextGraphId === graph
      && item.executorAgentAddress.toLowerCase() === executor.toLowerCase()
      && item.workflowId === grant.workflowId && item.workflowSha256 === grant.workflowSha256);
  };
  const authorized = async () => { await assertAuthorized(); if (!matches()) throw new Error('N8N_WORKFLOW_NOT_INSTALLED'); };
  const checkpoint = (effectId: string): Checkpoint | null => {
    const saved = store.adapterCheckpoint(effectId);
    if (!saved) return null;
    const value = JSON.parse(new TextDecoder().decode(saved.payload));
    if (value.kind !== 'n8n-native-v1' || value.workflowId !== grant.workflowId || value.workflowSha256 !== grant.workflowSha256
      || typeof value.executionId !== 'string' || !/^\d{1,20}$/.test(value.executionId) || typeof value.versionId !== 'string'
      || typeof value.observed !== 'boolean') throw new Error('N8N_CHECKPOINT_INVALID');
    return value;
  };
  const persist = (authorization: Readonly<PreparedEffectToken>, value: Checkpoint) => {
    const current = store.adapterCheckpoint(authorization.effectId);
    if (current) { if (JSON.stringify(checkpoint(authorization.effectId)) !== JSON.stringify(value)) throw new Error('N8N_CHECKPOINT_CONFLICT'); return; }
    store.writeAdapterCheckpoint(authorization.effectId, authorization.requestDigest, new TextEncoder().encode(JSON.stringify(value)), 0);
  };
  const preflight = async (signal: AbortSignal) => {
    await authorized();
    const origin = new URL(installation!.baseUrl), headers = { 'X-N8N-API-KEY': secret(installation!.apiTokenFile) };
    const workflow = await request(new URL(`/api/v1/workflows/${grant.workflowId}`, origin), headers, signal);
    const published = n8nRecord(workflow.activeVersion) ? { ...workflow.activeVersion, settings: workflow.settings } : workflow;
    if (workflow.id !== grant.workflowId || workflow.active !== true || typeof published.versionId !== 'string'
      || n8nWorkflowSha256(published) !== grant.workflowSha256) throw new Error('N8N_WORKFLOW_NOT_PINNED');
    const names = new Set((published.nodes as Record<string, unknown>[]).map(node => node.name));
    if ([...grant.result!.nodes, ...grant.result!.traceNodes ?? []].some(name => !names.has(name))) throw new Error('N8N_WORKFLOW_NOT_PINNED');
    return { origin, headers, published };
  };
  const inspect = async (saved: Checkpoint, signal: AbortSignal, prepared?: Awaited<ReturnType<typeof preflight>>) => {
    const { origin, headers, published } = prepared ?? await preflight(signal);
    let execution: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 60; attempt++) {
      await authorized();
      execution = await request(new URL(`/api/v1/executions/${saved.executionId}?includeData=true`, origin), headers, signal);
      if (!['new', 'running', 'waiting'].includes(String(execution.status))) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (['new', 'running', 'waiting'].includes(String(execution.status))) throw new Error('N8N_EXECUTION_PENDING');
    if (String(execution.id) !== saved.executionId || execution.workflowId !== grant.workflowId
      || !['success', 'error'].includes(String(execution.status)) || execution.workflowVersionId !== saved.versionId
      || !n8nExecutionMatches(published, execution.workflowData)) throw new Error('N8N_EXECUTION_NOT_VERIFIED');
    if (saved.observed) {
      const scope = n8nObservationScope(graph, executor, grant.workflowId);
      const data = n8nRecord(execution.data) && n8nRecord(execution.data.resultData) ? execution.data.resultData.runData : undefined;
      if (!n8nRecord(data) || !Array.isArray(data[scope]) || !data[scope].length) throw new Error('N8N_OBSERVATION_SCOPE_MISMATCH');
    }
    const value = collectN8nExecutionResult(grant, execution);
    assertN8nValue(grant.outputSchema, value, 'OUTPUT');
    await authorized();
    const output = JSON.stringify({ kind: 'n8n-result', workflowId: grant.workflowId, workflowSha256: grant.workflowSha256,
      n8nExecutionId: saved.executionId, output: value });
    return { status: 'succeeded' as const, output,
      evidenceRef: 'urn:sr:n8n-execution:' + saved.executionId + ':' + createHash('sha256').update(output).digest('hex') };
  };
  return {
    id: 'n8n/workflow', version: '1', witInterface: 'origintrail:semantic-runtime/n8n-workflow@0.1.0',
    implementationVersion: 'n8n-native-components-v1',
    implementationHash: createHash('sha256').update(readFileSync(new URL(import.meta.url)))
      .update(collectN8nExecutionResult.toString()).update(configuration).update(JSON.stringify(grant)).digest('hex'),
    enabled: matches, effectClass: 'external-workflow', verb: 'invoke', idempotencyClass: 'non_repeatable',
    reconciliationRule: 'inspect-pinned-n8n-execution-from-durable-acknowledgement',
    validateInput(input) { assertN8nValue(grant.inputSchema, input, 'INPUT'); return structuredClone(input); },
    async dispatch(authorization, input) {
      let mayHaveExecuted = false;
      try {
        assertN8nValue(grant.inputSchema, input, 'INPUT');
        const signal = AbortSignal.timeout(15_000), prepared = await preflight(signal);
        let saved = checkpoint(authorization.effectId);
        mayHaveExecuted = !!saved;
        if (!saved) {
          const observed = n8nRecord(input) && typeof input.executionId === 'string' ? input.executionId : '';
          if (observed && (!grant.result!.allowObservation || !/^\d{1,20}$/.test(observed))) throw new Error('INVALID_N8N_INPUT');
          if (observed && !(prepared.published.nodes as Record<string, unknown>[]).some(node => node.name === n8nObservationScope(graph, executor, grant.workflowId))) throw new Error('N8N_OBSERVATION_SCOPE_MISMATCH');
          await authorized();
          mayHaveExecuted = true;
          const response = observed ? { executionId: observed } : await request(new URL(`/webhook/dkg-capability-${grant.workflowId}`, prepared.origin),
            { authorization: `Bearer ${secret(installation!.webhookTokenFile)}` }, signal, { invocationId: authorization.effectId, input });
          if (typeof response.executionId !== 'string' || !/^\d{1,20}$/.test(response.executionId)
            || Object.keys(response).some(key => key !== 'executionId')) throw new Error('N8N_RESPONSE_INVALID');
          saved = { kind: 'n8n-native-v1', workflowId: grant.workflowId, workflowSha256: grant.workflowSha256,
            executionId: response.executionId, versionId: prepared.published.versionId as string, observed: !!observed };
          persist(authorization, saved);
        }
        return await inspect(saved, signal, prepared);
      } catch (error) {
        const code = error instanceof Error && /^(N8N|INVALID)_[A-Z0-9_]+$/.test(error.message) ? error.message : 'N8N_INVOCATION_FAILED';
        throw new NativeError(mayHaveExecuted, code);
      }
    },
    async resume(authorization, input) {
      assertN8nValue(grant.inputSchema, input, 'INPUT');
      const saved = checkpoint(authorization.effectId);
      if (!saved) throw new Error('N8N_EXECUTION_INSPECTION_REQUIRED');
      return inspect(saved, AbortSignal.timeout(15_000));
    },
    async reconcile(effect) {
      const saved = checkpoint(effect.effectId);
      if (!saved) return { status: 'unknown', evidenceRef: 'urn:sr:n8n:execution-inspection-required' };
      try { const result = await inspect(saved, AbortSignal.timeout(15_000)); return { status: 'applied', output: result.output, evidenceRef: result.evidenceRef }; }
      catch { return { status: 'unknown', evidenceRef: 'urn:sr:n8n:execution-inspection-required' }; }
    },
    couldHaveReachedTarget(error) { return !(error instanceof NativeError) || error.mayHaveExecuted; },
  };
}
