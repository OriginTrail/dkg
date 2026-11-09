import { isDeepStrictEqual } from 'node:util';
import { n8nPinnedExecutionMatches, n8nRecord } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

const reject = message => Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 });

/** Verify native pins and normalize the single recorded webhook input for the component journal. */
export async function readNativeExecutionInput(api, { workflowId, executionId, grant }) {
  const native=await api('/executions/'+encodeURIComponent(String(executionId))+'?includeData=true');
  const installed = await api('/workflows/'+workflowId);
  const published = n8nRecord(installed.activeVersion) ? { ...installed.activeVersion, settings: installed.settings } : installed;
  if (installed.id !== workflowId || installed.active !== true || String(native.id) !== executionId
    || !n8nPinnedExecutionMatches(published, native, grant, published.versionId))
    throw reject('Native execution does not match the approved workflow.');
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
