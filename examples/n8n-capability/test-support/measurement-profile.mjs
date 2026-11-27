/** Test-only fictional profile. No network, SSH, real node or real research data. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const graph = 'urn:test:measurements', target = 'urn:test:results';
const choice = value => ({ type: 'string', label: value, default: value, maxLength: 256, options: [value] });
const revision = 'c'.repeat(64);
const program = { id: 'sum-measurements', node: 'test-node', version: '1', contextGraphId: target,
  operationIri: 'urn:test:sum', bindingDigest: 'd'.repeat(64),
  program: { programIri: 'urn:test:program:sum', sourceHash: 'e'.repeat(64) } };
export const measurements = [{ sample: 'a', value: 2 }, { sample: 'b', value: 5 }];
export default {
  id: 'measurement-test', revision, node: 'test-node', targetGraph: target,
  programs: [program], catalogRevision: 'catalog-1',
  parameters: {
    'dkg-read': { node: choice('test-node'), contextGraph: choice(graph), dataset: choice('set-7') },
    'invoke-dkg-program': { node: choice('test-node'), program: choice(program.id), catalogRevision: choice('catalog-1') },
    'dkg-write': { node: choice('test-node'), contextGraph: choice(target) },
  },
  enabled: () => true,
  loadInputs: () => [],
  validateInput() {},
  validateNode(node) {
    if (node.params.node !== 'test-node' || node.componentId !== 'invoke-dkg-program' &&
      node.params.contextGraph !== (node.componentId === 'dkg-read' ? graph : target)) throw new Error('scope mismatch');
  },
  readRequest: node => ({ dataset: node.params.dataset }),
  readItems(input, result) {
    if (result.graph !== graph || !isDeepStrictEqual(result.measurements, measurements)) throw new Error('source mismatch');
    return result.measurements;
  },
  evidence(rows, context, read, input, programContext) {
    const calculated = programContext?.rawOutputs?.[0];
    if (programContext && (programContext.rawOutputs?.length !== 1 || !calculated || !isDeepStrictEqual(rows[0]?.result, calculated)))
      throw new Error('verified Program output mismatch');
    const records = programContext ? calculated.samples : rows;
    if (!isDeepStrictEqual(records, read.measurements)) throw new Error('provenance mismatch');
    const value = { kind: 'Measurements', records, execution: context.executionIri, result: calculated?.sum ?? null };
    const payload = JSON.stringify(value), digest = createHash('sha256').update(payload).digest('hex');
    return { payload: { digest, name: 'samples-' + digest,
      quads: [{ subject: 'urn:test:' + digest, predicate: 'urn:test:payload', object: JSON.stringify(payload), graph: '' }] },
      recordCount: records.length, summary: { measurementTotal: value.result } };
  },
  transport() { throw new Error('Test transport must be injected; no network fallback.'); },
};
