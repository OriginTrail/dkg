/** Fictional read-only profile for MCP tests. Never a production/customer profile. */
import { isDeepStrictEqual } from 'node:util';
import { measurements } from './measurement-profile.mjs';
export const calls = [];
const choice = value => ({ type: 'string', label: value, default: value, maxLength: 256, options: [value] });
const validateArguments = args => {
  if (Object.keys(args).join(',') !== 'sample' || !['a', 'b'].includes(args.sample)) throw new Error('Invalid typed sample selector');
};
export const profile = { id: 'agent-read-fixture', revision: 'c'.repeat(64), node: 'test-node', requiresNosActor: true, accountId: 'account-test',
  async authorize(actor) { if (actor.accountId !== this.accountId || actor.role !== 'owner') throw new Error('owner revoked'); },
  workflowTools: { effect: 'read', readGraphs: ['urn:test:measurements'], validateArguments },
  operations: { 'dkg-read': {
    parameters: { node: choice('test-node'), contextGraph: choice('urn:test:measurements'), dataset: choice('set-7') },
    enabled: () => true,
    validateInput(_definition, input) {
      const rows = JSON.parse(input.itemsJson);
      if (rows.length !== 1) throw new Error('One sample selector required');
      validateArguments(rows[0]);
    },
    validateNode(node) {
      if (node.params.node !== 'test-node' || node.params.contextGraph !== 'urn:test:measurements') throw new Error('scope mismatch');
    },
    readRequest(node, rows) { validateArguments(rows[0]); return { dataset: node.params.dataset, sample: rows[0].sample }; },
    readItems(_input, result) {
      if (result.graph !== 'urn:test:measurements' || !isDeepStrictEqual(result.measurements, measurements)) throw new Error('source mismatch');
      return result.measurements;
    },
    transport(request, context) {
      calls.push({ request, operation: 'read', context });
      return { graph: 'urn:test:measurements', measurements };
    },
  } },
};
export default profile;
