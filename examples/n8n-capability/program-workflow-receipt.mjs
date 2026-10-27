import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { programRecords } from './program-block.mjs';

/** Verify every child result against its persisted DKG receipt before exposing downstream output. */
export async function programWorkflowReceipt(compiled, result, input, loadOutputs) {
  const value = result.outputs[0], calls = result.trace?.calls.filter(c => c.kind === 'program') ?? [];
  if (value?.kind !== 'nos-program-workflow-result' || !Array.isArray(value.steps)
    || value.steps.length !== compiled.ordered.length) throw new Error('Program workflow child evidence is incomplete.');
  let callIndex = 0, items = programRecords(JSON.parse(input.itemsJson)), ok = true, error = '';
  const steps = [];
  for (const [i, node] of compiled.ordered.entries()) {
    const step = value.steps[i], previous = items;
    const allItems = node.componentId === 'run-program' && node.params.inputMode === 'all-items';
    const count = !ok || !items.length && !allItems ? 0 : node.componentId === 'run-program' && !allItems ? items.length : 1;
    if (step?.nodeId !== node.id || step.kaRef !== node.kaRef || !Array.isArray(step.results) || step.results.length !== count)
      throw new Error('Program workflow step identity or call count differs.');
    const childCalls = [];
    for (const output of step.results) {
      const call = calls[callIndex++];
      if (call?.target !== node.kaRef || call.status !== 'succeeded' || !/^urn:sr:execution:[a-f0-9-]{36}$/.test(call.executionIri ?? ''))
        throw new Error('Program workflow child invocation differs.');
      const stored = await loadOutputs(call.executionIri);
      const parsed = stored.map(raw => { try { return JSON.parse(raw); } catch { return raw; } });
      const persisted = parsed.length === 1 ? parsed[0] : parsed;
      if (!isDeepStrictEqual(persisted, output)) throw new Error('Program child receipt readback differs.');
      childCalls.push(call);
    }
    let status = 'skipped';
    if (count) {
      status = 'completed';
      if (node.componentId === 'run-program') items = programRecords(step.results.flatMap(v => Array.isArray(v) ? v : [v]));
      else {
        const native = step.results[0];
        if (native?.kind !== 'n8n-result' || !/^\d{1,20}$/.test(native.n8nExecutionId ?? '')
          || !/^[a-f0-9]{64}$/.test(native.workflowSha256 ?? '') || typeof native.output?.ok !== 'boolean') throw new Error('Native child evidence differs.');
        ok = native.output.ok;
        if (!ok) { status = 'failed'; error = String(native.output.error).slice(0, 512); items = []; }
        else items = programRecords(JSON.parse(native.output.itemsJson));
      }
    }
    if (step.status !== status) throw new Error('Program workflow step status differs.');
    steps.push({ nodeId: node.id, componentId: node.componentId, kaRef: node.kaRef, sourceHash: node.sourceHash,
      node: 'Block ' + node.id, status, items: [count ? items.length : 0],
      outputHash: createHash('sha256').update(JSON.stringify(count ? items : [])).digest('hex'),
      executionIris: childCalls.map(call => call.executionIri),
      ...(node.componentId === 'run-program' ? { programVersion: node.params.version } : { n8nExecutionIds: step.results.map(v => v.n8nExecutionId) }) });
    if (!count && ok && previous.length) throw new Error('A non-empty workflow step was unexpectedly skipped.');
  }
  const expected = { ok, itemsJson: JSON.stringify(items), portsJson: '{}', error };
  if (callIndex !== calls.length || !isDeepStrictEqual(value.output, expected)) throw new Error('Program workflow output differs from its child receipts.');
  return { executor: 'dkg', output: expected, steps: compiled.definition.nodes.map(n => steps.find(s => s.nodeId === n.id)),
    persisted: true, readbackVerified: true };
}
