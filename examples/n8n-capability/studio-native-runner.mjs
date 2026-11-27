import { readFileSync } from 'node:fs';
import { exchangeNativeN8nWebhook, pinnedN8nPublishedWorkflow } from '../../packages/cli/dist/semantic-runtime-n8n-wire.js';
import { validateN8nGrant, normalizeN8nResult } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { collectN8nExecutionResult } from '../../packages/cli/dist/semantic-runtime-n8n-results.js';
import { nativeExecutionError as fail, verifyNativeExecutionInput } from './studio-native-execution.mjs';

/** Native transport only: no Program upload, approval, invocation or execution receipt. */
export function createStudioNativeRunner(provider, installation, send = fetch) {
  async function prepare(workflow) {
    const grant = workflow.grant, native = await provider.api('/workflows/' + grant.workflowId);
    const published = pinnedN8nPublishedWorkflow(native, grant, () => fail('STUDIO_NATIVE_PIN_CHANGED'));
    return published.versionId;
  }
  async function dispatch(workflow, runKey, input) {
    const token = readFileSync(installation.webhookTokenFile, 'utf8').trim();
    if (token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    return exchangeNativeN8nWebhook({ baseUrl: installation.baseUrl, workflowId: workflow.grant.workflowId,
      token, invocationId: runKey, input, signal: AbortSignal.timeout(12_000), maxBytes: 512, send,
      error: () => fail('STUDIO_NATIVE_UNCONFIRMED') });
  }

  async function loadExecution(workflow, checkpoint) {
    if (!/^\d{1,20}$/.test(checkpoint.executionId ?? '')) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    const execution = await provider.api('/executions/' + checkpoint.executionId + '?includeData=true');
    if (String(execution.id) !== checkpoint.executionId || execution.workflowId !== workflow.grant.workflowId)
      throw fail('STUDIO_NATIVE_UNCONFIRMED');
    return execution;
  }
  /**
   * @param {object} workflow
   * @param {import('./studio-native-execution.mjs').NativeExecutionCheckpoint} checkpoint
   */
  async function verifyCallback(workflow, checkpoint) {
    const execution = await loadExecution(workflow, checkpoint);
    const running = ['new', 'running', 'waiting'].includes(execution.status);
    if (!running && !['success', 'error', 'canceled', 'crashed'].includes(execution.status)) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    return verifyNativeExecutionInput(workflow, checkpoint, execution, !running);
  }
  /**
   * @param {object} workflow
   * @param {import('./studio-native-execution.mjs').NativeExecutionCheckpoint} checkpoint
   */
  async function inspect(workflow, checkpoint) {
    const execution = await loadExecution(workflow, checkpoint);
    if (['new', 'running', 'waiting'].includes(execution.status)) return { status: 'running' };
    if (!['success', 'error', 'canceled', 'crashed'].includes(execution.status)) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    verifyNativeExecutionInput(workflow, checkpoint, execution, true);
    if (execution.status !== 'success') return { status: 'failed' };
    try {
      validateN8nGrant(workflow.grant);
      const projection = normalizeN8nResult(workflow.grant.result);
      const result = collectN8nExecutionResult(projection, execution);
      if (!result.ok) return { status: 'failed' };
      const output = { items: JSON.parse(result.itemsJson), ports: JSON.parse(result.portsJson) };
      if (Buffer.byteLength(JSON.stringify(output)) > 16_384) return { status: 'failed' };
      return { status: 'succeeded', output, steps: JSON.parse(result.traceJson ?? '[]') };
    } catch {
      // Identity and terminal state were verified above. Malformed/oversized
      // result data fails the run; it cannot retain an already finished slot.
      return { status: 'failed' };
    }
  }
  return { prepare, dispatch, inspect, verifyCallback };
}
