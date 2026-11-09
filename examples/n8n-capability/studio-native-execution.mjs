import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../../packages/core/dist/index.js';
import { n8nPinnedExecutionMatches, n8nRecord } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

const reject = message => Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 });
export const nativeExecutionError = (code = 'STUDIO_NATIVE_UNCONFIRMED') => Object.assign(new Error(code), { code, status: 409 });

/**
 * Transport checkpoint shared by terminal inspection and callback verification.
 * The run key and exact wire-input digest are recorded before dispatch; version
 * and execution IDs are filled by preflight and acknowledgement respectively.
 * A legacy null digest is missing evidence, never inferred from provider data.
 * @typedef {object} NativeExecutionCheckpoint
 * @property {string|null} executionId Acknowledged provider execution, or null before acknowledgement.
 * @property {string|null} versionId Pinned provider version, or null before preflight.
 * @property {string} runKey Identity sent as the webhook invocationId.
 * @property {string|null} inputDigest SHA-256 of the admitted wire input; null for legacy admissions.
 */

/** Hash the normalized wire input, without storing arguments or depending on today's profile. */
export function nativeInputDigest(input) {
  if (!n8nRecord(input) || Object.keys(input).some(key => !['itemsJson', 'paramsJson', 'executionId'].includes(key))
    || !['itemsJson', 'paramsJson', 'executionId'].every(key => typeof input[key] === 'string'))
    throw nativeExecutionError();
  return createHash('sha256').update(canonicalizeJson(input, { maxBytes: 16_384, maxDepth: 12 })).digest('hex');
}

/**
 * After transport checks execution identity, bind input to the saved native pins.
 * Running callbacks may use pending input; terminal attribution requires a
 * completed Receive input task even for failed executions before slot release.
 * @param {object} workflow Saved native workflow and grant.
 * @param {NativeExecutionCheckpoint} checkpoint
 * @param {object} execution Provider execution readback.
 * @param {boolean} terminal Whether completed input evidence is required.
 */
export function verifyNativeExecutionInput(workflow, checkpoint, execution, terminal) {
  const published = { ...workflow.published, versionId: checkpoint.versionId };
  if (!n8nPinnedExecutionMatches(published, execution, workflow.grant, checkpoint.versionId)) throw nativeExecutionError();
  try {
    if (terminal && execution.data?.resultData?.runData?.['Receive input'] === undefined) throw nativeExecutionError();
    const received = recordedNativeExecutionInput(execution);
    if (received.invocationId !== checkpoint.runKey || typeof checkpoint.inputDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(checkpoint.inputDigest)
      || nativeInputDigest(received.input) !== checkpoint.inputDigest) throw nativeExecutionError();
    return received;
  } catch { throw nativeExecutionError(); }
}

/** Verify native pins and normalize the single recorded webhook input for the component journal. */
export async function readNativeExecutionInput(api, { workflowId, executionId, grant }) {
  const native=await api('/executions/'+encodeURIComponent(String(executionId))+'?includeData=true');
  const installed = await api('/workflows/'+workflowId);
  const published = n8nRecord(installed.activeVersion) ? { ...installed.activeVersion, settings: installed.settings } : installed;
  if (installed.id !== workflowId || installed.active !== true || String(native.id) !== executionId
    || !n8nPinnedExecutionMatches(published, native, grant, published.versionId))
    throw reject('Native execution does not match the approved workflow.');
  return recordedNativeExecutionInput(native);
}

/** Extract the unique recorded input after the caller verifies its native execution pins. */
export function recordedNativeExecutionInput(native) {
  // Running webhook executions retain their initial input on the pending stack;
  // completed/progress-saved executions expose it as Receive input run data.
  const received = [];
  const take = task => {
    const ports = task?.data?.main;
    if (task?.error || !Array.isArray(ports) || ports.length !== 1 || !Array.isArray(ports[0])
      || ports[0].length !== 1 || !n8nRecord(ports[0][0]?.json?.body))
      throw reject('Native execution has no unique recorded Receive input.');
    received.push(ports[0][0].json.body);
  };
  const runs = native.data?.resultData?.runData?.['Receive input'];
  if (runs !== undefined) {
    if (!Array.isArray(runs) || runs.length !== 1) throw reject('Native execution has no unique recorded Receive input.');
    take(runs[0]);
  }
  const stack = native.data?.executionData?.nodeExecutionStack;
  if (stack !== undefined && !Array.isArray(stack)) throw reject('Native execution has no unique recorded Receive input.');
  const pending = (stack ?? []).filter(task => task?.node?.name === 'Receive input');
  if (pending.length > 1) throw reject('Native execution has no unique recorded Receive input.');
  pending.forEach(take);
  if (!received.length || received.some(body => !isDeepStrictEqual(body, received[0])))
    throw reject('Native execution has no unique recorded Receive input.');
  return received[0];
}
