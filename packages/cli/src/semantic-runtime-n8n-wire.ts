import { BoundedResponseBodyLimitError, readResponseBodyBytesBounded } from '@origintrail-official/dkg-http-utils';
import { decodeN8nWorkflowSnapshot, n8nRecord, n8nWorkflowSha256, type N8nPublishedWorkflow } from './semantic-runtime-n8n-contract.js';

type WireError = (code: string, context?: { status: number }) => Error;
const wireError: WireError = code => new Error(code);

/** Provider JSON only. Deadlines, credentials and execution authority belong to the caller. */
export async function requestN8nJson(url: URL, options: {
  headers: Record<string, string>; signal: AbortSignal; body?: unknown;
  method?: 'GET' | 'POST' | 'PUT';
  maxBytes?: number; send?: typeof fetch; error?: WireError;
}): Promise<Record<string, unknown>> {
  const { headers, signal, body, method = body === undefined ? 'GET' : 'POST', maxBytes = 1_048_576, send = fetch, error = wireError } = options;
  const response = await send(url, { method, redirect: 'error', signal,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const context = { status: response.status };
  if (!response.ok || !response.body) { await response.body?.cancel(); throw error('N8N_REQUEST_FAILED', context); }
  let bytes: Uint8Array;
  try { bytes = await readResponseBodyBytesBounded(response, maxBytes); }
  catch (cause) {
    if (cause instanceof BoundedResponseBodyLimitError) throw error('N8N_RESPONSE_TOO_LARGE', context);
    throw cause;
  }
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!n8nRecord(value)) throw error('N8N_RESPONSE_INVALID', context);
  return value;
}

export function pinnedN8nPublishedWorkflow(workflow: Record<string, unknown>,
  grant: { workflowId: string; workflowSha256: string }, error = wireError,
): N8nPublishedWorkflow {
  const value = n8nRecord(workflow.activeVersion) ? { ...workflow.activeVersion, settings: workflow.settings } : workflow;
  if (workflow.id !== grant.workflowId || workflow.active !== true || typeof value.versionId !== 'string'
    || !value.versionId) throw error('N8N_WORKFLOW_NOT_PINNED');
  const published = decodeN8nWorkflowSnapshot(value);
  if (n8nWorkflowSha256(published) !== grant.workflowSha256) throw error('N8N_WORKFLOW_NOT_PINNED');
  return { ...published, versionId: value.versionId };
}

/** Native acknowledgement contains only a durable execution ID, never workflow output. */
export async function exchangeNativeN8nWebhook(options: {
  baseUrl: string | URL; workflowId: string; token: string; invocationId: string; input: unknown;
  signal: AbortSignal; maxBytes: number; send?: typeof fetch; error?: WireError;
}): Promise<string> {
  const { baseUrl, workflowId, token, invocationId, input, signal, maxBytes, send, error = wireError } = options;
  const ack = await requestN8nJson(new URL(`/webhook/dkg-capability-${workflowId}`, baseUrl), {
    headers: { authorization: `Bearer ${token}` }, body: { invocationId, input }, signal, maxBytes, send, error,
  });
  if (typeof ack.executionId !== 'string' || !/^\d{1,20}$/.test(ack.executionId) || Object.keys(ack).length !== 1)
    throw error('N8N_RESPONSE_INVALID');
  return ack.executionId;
}
