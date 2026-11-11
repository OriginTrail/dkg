import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeAdapterOperation, SemanticN8nConfig, SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { normalizeN8nResult, type NativeN8nGrant, assertN8nEmbeddedWorkflows, n8nResultSha256, assertN8nValue, n8nPinnedExecutionMatches, n8nObservationScope, n8nRecord, validateN8nConfig, validateN8nGrant } from './semantic-runtime-n8n-contract.js';
import { exchangeNativeN8nWebhook, pinnedN8nPublishedWorkflow, requestN8nJson } from './semantic-runtime-n8n-wire.js';
import { collectN8nExecutionResult } from './semantic-runtime-n8n-results.js';
import { nativeN8nImplementation } from './semantic-runtime-n8n-implementation.generated.js';

import { encodeNativeN8nCheckpoint, readNativeN8nCheckpoint, type NativeN8nCheckpoint } from './semantic-runtime-n8n-checkpoint.js';
type PreparedEffectToken = Parameters<RuntimeAdapterOperation['dispatch']>[0];
// Studio allows 45s Program callbacks inside a 50s native workflow and a 60s
// parent. Keep inspection alive through the native limit, with receipt margin.
const inspectionTimeoutMs = 55_000;
class NativeError extends Error {
  constructor(readonly mayHaveExecuted: boolean, code: string) { super(code); }
}
const secret = (path: string): string => {
  const bytes = readFileSync(path);
  const value = bytes.toString('utf8').trim();
  if (bytes.length > 8192 || value.length < 16 || /[\r\n]/.test(value)) throw new Error('N8N_CREDENTIAL_UNAVAILABLE');
  return value;
};
function request(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  return requestN8nJson(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
}

/** Early acknowledgement + durable provider execution ID; continuation never POSTs again. */
export function createNativeN8nWorkflowAdapter(
  graph: string, executor: string, approved: NativeN8nGrant,
  installation: SemanticN8nConfig | undefined, assertAuthorized: () => Promise<void>, store: SemanticRuntimeStore,
): RuntimeAdapterOperation<unknown, string> {
  validateN8nGrant(approved);
  const grant = structuredClone(approved);
  const projection = normalizeN8nResult(grant.result);
  const selectedConfiguration = () => installation && ({ ...installation, workflows: installation.workflows.filter(item =>
    item.contextGraphId === graph && item.executorAgentAddress.toLowerCase() === executor.toLowerCase() && item.workflowId === grant.workflowId) });
  const configuration = JSON.stringify(selectedConfiguration());
  const matches = () => {
    if (!installation || configuration !== JSON.stringify(selectedConfiguration())) return false;
    validateN8nConfig(installation);
    return installation.workflows.some(item => item.contextGraphId === graph
      && item.executorAgentAddress.toLowerCase() === executor.toLowerCase()
      && item.workflowId === grant.workflowId && item.workflowSha256 === grant.workflowSha256
      && item.resultSha256 === n8nResultSha256(grant));
  };
  const authorized = async () => { await assertAuthorized(); if (!matches()) throw new Error('N8N_WORKFLOW_NOT_INSTALLED'); };
  const checkpoint = (effectId: string) => readNativeN8nCheckpoint(store, effectId, grant);
  const persist = (authorization: Readonly<PreparedEffectToken>, value: NativeN8nCheckpoint) => {
    const current = store.adapterCheckpoint(authorization.effectId);
    if (current) { if (JSON.stringify(checkpoint(authorization.effectId)) !== JSON.stringify(value)) throw new Error('N8N_CHECKPOINT_CONFLICT'); return; }
    store.writeAdapterCheckpoint(authorization.effectId, authorization.requestDigest, encodeNativeN8nCheckpoint(value), 0);
  };
  const preflight = async (signal: AbortSignal) => {
    await authorized();
    const origin = new URL(installation!.baseUrl), headers = { 'X-N8N-API-KEY': secret(installation!.apiTokenFile) };
    const workflow = await request(new URL(`/api/v1/workflows/${grant.workflowId}`, origin), headers, signal);
    const published = pinnedN8nPublishedWorkflow(workflow, grant);
    assertN8nEmbeddedWorkflows(published);
    const names = new Set(published.nodes.map(node => node.name));
    if (projection.requiredNodes.some(name => !names.has(name))) throw new Error('N8N_WORKFLOW_NOT_PINNED');
    return { origin, headers, published };
  };
  const inspect = async (saved: NativeN8nCheckpoint, signal: AbortSignal, prepared?: Awaited<ReturnType<typeof preflight>>) => {
    const { origin, headers, published } = prepared ?? await preflight(signal);
    let execution: Record<string, unknown> = {};
    for (;;) {
      signal.throwIfAborted();
      await authorized();
      execution = await request(new URL(`/api/v1/executions/${saved.executionId}?includeData=true`, origin), headers, signal);
      if (!['new', 'running', 'waiting'].includes(String(execution.status))) break;
      await delay(200, undefined, { signal });
    }
    if (String(execution.id) !== saved.executionId || execution.workflowId !== grant.workflowId
      || !['success', 'error', 'canceled', 'crashed'].includes(String(execution.status))
      || !n8nPinnedExecutionMatches(published, execution, grant, saved.versionId)) throw new Error('N8N_EXECUTION_NOT_VERIFIED');
    if (saved.observed) {
      const scope = n8nObservationScope(graph, executor, grant.workflowId);
      const data = n8nRecord(execution.data) && n8nRecord(execution.data.resultData) ? execution.data.resultData.runData : undefined;
      if (!n8nRecord(data) || !Array.isArray(data[scope]) || !data[scope].length) throw new Error('N8N_OBSERVATION_SCOPE_MISMATCH');
    }
    const value = collectN8nExecutionResult(projection, execution);
    assertN8nValue(grant.outputSchema, value, 'OUTPUT');
    await authorized();
    const output = JSON.stringify({ kind: 'n8n-result', workflowId: grant.workflowId, workflowSha256: grant.workflowSha256,
      n8nExecutionId: saved.executionId, output: value });
    return { status: 'succeeded' as const, output,
      evidenceRef: 'urn:sr:n8n-execution:' + saved.executionId + ':' + createHash('sha256').update(output).digest('hex') };
  };
  return {
    id: 'n8n/workflow', version: '1', witInterface: 'origintrail:semantic-runtime/n8n-workflow@0.1.0',
    implementationVersion: nativeN8nImplementation.version,
    implementationHash: createHash('sha256').update(JSON.stringify([
      nativeN8nImplementation, configuration, grant,
    ])).digest('hex'),
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
          if (observed && (!projection.allowObservation || !/^\d{1,20}$/.test(observed))) throw new Error('INVALID_N8N_INPUT');
          if (observed && !prepared.published.nodes.some(node => node.name === n8nObservationScope(graph, executor, grant.workflowId))) throw new Error('N8N_OBSERVATION_SCOPE_MISMATCH');
          const webhookToken = observed ? undefined : secret(installation!.webhookTokenFile);
          await authorized();
          mayHaveExecuted = true;
          const executionId = observed || await exchangeNativeN8nWebhook({ baseUrl: prepared.origin, workflowId: grant.workflowId,
            token: webhookToken!, invocationId: authorization.effectId, input, signal, maxBytes: 1_048_576 });
          saved = { kind: 'n8n-native-v1', workflowId: grant.workflowId, workflowSha256: grant.workflowSha256,
            executionId, versionId: prepared.published.versionId, observed: !!observed };
          persist(authorization, saved);
        }
        return await inspect(saved, AbortSignal.timeout(inspectionTimeoutMs), prepared);
      } catch (error) {
        const code = error instanceof Error && /^(N8N|INVALID)_[A-Z0-9_]+$/.test(error.message) ? error.message : 'N8N_INVOCATION_FAILED';
        throw new NativeError(mayHaveExecuted, code);
      }
    },
    async resume(authorization, input) {
      assertN8nValue(grant.inputSchema, input, 'INPUT');
      const saved = checkpoint(authorization.effectId);
      if (!saved) throw new Error('N8N_EXECUTION_INSPECTION_REQUIRED');
      return inspect(saved, AbortSignal.timeout(inspectionTimeoutMs));
    },
    async reconcile(effect) {
      const saved = checkpoint(effect.effectId);
      if (!saved) return { status: 'unknown', evidenceRef: 'urn:sr:n8n:execution-inspection-required' };
      try { const result = await inspect(saved, AbortSignal.timeout(inspectionTimeoutMs)); return { status: 'applied', output: result.output, evidenceRef: result.evidenceRef }; }
      catch { return { status: 'unknown', evidenceRef: 'urn:sr:n8n:execution-inspection-required' }; }
    },
    couldHaveReachedTarget(error) { return !(error instanceof NativeError) || error.mayHaveExecuted; },
  };
}
