import { describe, expect, it } from 'vitest';
import { DkgClient } from '../src/client.js';
import { registerReadTools } from '../src/tools.js';
import { FakeServer, makeConfig } from './harness.js';

const did = 'did:dkg:agent:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
describe('context graph transport normalization', () => {
  it('normalizes malformed membership once before identity lookup and selection', async () => {
    let identityReads = 0;
    const config = makeConfig();
    const client = new DkgClient({ config, fetcher: async (url) => {
      if (String(url).endsWith('/api/agent/identity')) { identityReads++; return Response.json({ agentDid: did }); }
      return Response.json({ contextGraphs: [
        { id: 'legacy', name: 'Legacy', callerInvolved: null, curator: did, marker: 'preserved' },
        { id: 'truthy-is-not-membership', callerInvolved: 'true', curator: 42 },
        { id: 'excluded', callerInvolved: false, curator: did },
        { id: 'explicit', callerInvolved: true, curator: 42 },
        null, [], { name: 'no id' }, { id: 42 },
      ] });
    } });
    const rows = await client.listProjects();
    expect(rows.map((row) => row.id)).toEqual(['legacy', 'truthy-is-not-membership', 'excluded', 'explicit']);
    expect(rows[0]).toEqual({ id: 'legacy', name: 'Legacy', curator: did, marker: 'preserved' });
    expect(rows[1]).toEqual({ id: 'truthy-is-not-membership' });
    expect(rows[3]).toEqual({ id: 'explicit', callerInvolved: true });
    const tools = new FakeServer();
    registerReadTools(tools.asMcpServer(), client, config);
    const result = await tools.call('dkg_list_context_graphs', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Found 2 context graph(s)');
    expect(result.content[0].text).toContain('**legacy**');
    expect(result.content[0].text).toContain('**explicit**');
    expect(identityReads).toBe(1);
  });

  it('normalizes name metadata without losing valid chain or display fields', async () => {
    const valid = { id: 'valid', name: 'Name', description: 'Details', role: 'curator', layer: 'public', nameKnown: true, isSystem: false, onChain: { nameHash: null, owner: 'keep' } };
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => Response.json({ contextGraphs: [
      valid,
      { id: 'bad', name: 12, description: [], role: {}, layer: null, nameKnown: 'true', isSystem: 1, onChain: { nameHash: 42, owner: 'keep' } },
      { id: 'chain-hash', onChain: { nameHash: '0xhash' } },
      { id: 'no-chain', onChain: 'invalid' },
    ] }) });
    expect(await client.listProjects()).toEqual([valid, { id: 'bad', onChain: { owner: 'keep' } }, { id: 'chain-hash', onChain: { nameHash: '0xhash' } }, { id: 'no-chain' }]);
  });

  it.each([undefined, null, 'invalid', {}])('tolerates a malformed or absent contextGraphs array %j', async (contextGraphs) => {
    const client = new DkgClient({ config: makeConfig(), fetcher: async () => Response.json({ contextGraphs }) });
    expect(await client.listProjects()).toEqual([]);
  });
});
