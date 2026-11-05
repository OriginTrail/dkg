import { readFileSync } from 'node:fs';
import { n8nWorkflowSha256, n8nPinnedExecutionMatches } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { collectN8nExecutionResult } from '../../packages/cli/dist/semantic-runtime-n8n-results.js';
import { fail } from './studio-mcp-contract.mjs';

/** Native transport only: no Program upload, approval, invocation or execution receipt. */
export function createStudioNativeRunner(provider, installation, send = fetch) {
  async function prepare(workflow) {
    const grant = workflow.grant, native = await provider.api('/workflows/' + grant.workflowId);
    const published = native.activeVersion ? { ...native.activeVersion, settings: native.settings } : native;
    if (native.id !== grant.workflowId || !native.active || typeof published.versionId !== 'string'
      || !published.versionId || n8nWorkflowSha256(published) !== grant.workflowSha256) throw fail('STUDIO_NATIVE_PIN_CHANGED');
    return published.versionId;
  }
  async function dispatch(workflow, runKey, input) {
    const token = readFileSync(installation.webhookTokenFile, 'utf8').trim();
    if (token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    const response = await send(new URL('/webhook/dkg-capability-' + workflow.grant.workflowId, installation.baseUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ invocationId: runKey, input }),
    });
    let size = 0; const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 512) throw fail('STUDIO_NATIVE_UNCONFIRMED');
      chunks.push(chunk);
    }
    if (!response.ok) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!ack || Object.keys(ack).length !== 1 || typeof ack.executionId !== 'string' || !/^\d{1,20}$/.test(ack.executionId))
      throw fail('STUDIO_NATIVE_UNCONFIRMED');
    return ack.executionId;
  }
  async function inspect(workflow, saved, runKey) {
    const execution = await provider.api('/executions/' + saved.execution_id + '?includeData=true');
    if (String(execution.id) !== saved.execution_id || execution.workflowId !== workflow.grant.workflowId)
      throw fail('STUDIO_NATIVE_UNCONFIRMED');
    if (['new', 'running', 'waiting'].includes(execution.status)) return { status: 'running' };
    // Use the saved immutable native snapshot, not whichever revision is currently
    // published. Pin verification also applies to failed executions before releasing capacity.
    const published = { ...workflow.published, versionId: saved.version_id };
    if (!['success', 'error', 'canceled', 'crashed'].includes(execution.status)
      || !n8nPinnedExecutionMatches(published, execution, workflow.grant, saved.version_id)) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    const received = execution.data?.resultData?.runData?.['Receive input']?.[0]?.data?.main?.[0]?.[0]?.json?.body;
    if (received?.invocationId !== runKey) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    if (execution.status !== 'success') return { status: 'failed' };
    try {
      const result = collectN8nExecutionResult(workflow.grant, execution);
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
  return { prepare, dispatch, inspect };
}
