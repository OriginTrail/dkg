import { describe, expect, it } from 'vitest';
import { DkgClient } from '../src/client.js';
import { registerReadTools } from '../src/tools.js';
import { contextGraphDisplayName, type ProjectRow } from '../src/project-row.js';
import { FakeServer, makeConfig } from './harness.js';

const did = 'did:dkg:agent:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hash = `0x${'a'.repeat(64)}`;
const names: Array<{ label: string; row: ProjectRow; expected: string | null }> = [
  { label: 'ordinary same-name graph', row: { id: 'team', name: 'team' }, expected: 'team' },
  { label: 'explicit known name', row: { id: 'team', name: 'team', nameKnown: true }, expected: 'team' },
  { label: 'explicit unknown name', row: { id: 'team', name: 'stale', nameKnown: false }, expected: null },
  { label: 'missing name', row: { id: 'team' }, expected: null },
  { label: 'blank name', row: { id: 'team', name: ' ' }, expected: null },
  { label: 'empty name', row: { id: 'team', name: '' }, expected: null },
  { label: 'known blank name', row: { id: 'team', name: ' ', nameKnown: true }, expected: null },
  { label: 'legacy hash ID without provenance', row: { id: hash, name: hash }, expected: null },
  { label: 'hash name with a different ID', row: { id: 'local', name: hash, onChain: { nameHash: hash } }, expected: hash },
  { label: 'known flag is authoritative', row: { id: hash, name: hash, nameKnown: true, onChain: { nameHash: hash } }, expected: hash },
  { label: 'name comparison to the ID remains case-sensitive', row: { id: hash, name: hash.toUpperCase() }, expected: hash.toUpperCase() },
  { label: 'canonical chain hash does not mask a name', row: { id: 'local', name: hash.toUpperCase(), onChain: { nameHash: hash } }, expected: hash.toUpperCase() },
  { label: 'noncanonical chain hash does not mask a name', row: { id: 'local', name: hash, onChain: { nameHash: hash.toUpperCase() } }, expected: hash },
  { label: 'different chain provenance', row: { id: 'local', name: hash, onChain: { nameHash: `0x${'b'.repeat(64)}` } }, expected: hash },
];

describe('MCP Context Graph display names', () => {
  it.each(names)('$label', ({ row, expected }) => {
    expect(contextGraphDisplayName(row)).toBe(expected);
  });
});

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
