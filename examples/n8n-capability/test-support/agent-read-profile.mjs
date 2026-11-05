/** Fictional read-only profile for MCP tests. Never a production/customer profile. */
import base, { measurements } from './measurement-profile.mjs';
export const calls = [];
export const profile = { ...base, id: 'agent-read-fixture', requiresNosActor: true, accountId: 'account-test',
  enabled: id => id === 'dkg-read',
  async authorize(actor) { if (actor.accountId !== this.accountId || actor.role !== 'owner') throw new Error('owner revoked'); },
  workflowTools: { effect: 'read', readGraphs: ['urn:test:measurements'],
    validateArguments(args) { if (Object.keys(args).join(',') !== 'sample' || !['a', 'b'].includes(args.sample)) throw new Error('Invalid typed sample selector'); } },
  readRequest(node, rows) { this.workflowTools.validateArguments(rows[0]); return { dataset: node.params.dataset, sample: rows[0].sample }; },
  transport(request, operation, context) {
    if (operation !== 'read') throw new Error('Read only');
    calls.push({ request, operation, context });
    return { graph: 'urn:test:measurements', measurements };
  },
};
export default profile;
