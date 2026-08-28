import { describe, expect, it } from 'vitest';
import type { QueryEngine } from '@origintrail-official/dkg-query';
import { DiscoveryClient } from '../src/discovery.js';

describe('DiscoveryClient.findAgents distinct-row boundary', () => {
  it('requests DISTINCT rows and collapses bindings that normalize identically', async () => {
    let issuedQuery = '';
    const duplicate = {
      agent: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
      name: '"same"',
      peerId: '"peer-same"',
      framework: '"OpenClaw"',
      agentAddress: '"0x1111111111111111111111111111111111111111"',
    };
    const engine = {
      query: async (sparql: string) => {
        issuedQuery = sparql;
        return { bindings: [duplicate, { ...duplicate }] };
      },
    } as unknown as QueryEngine;

    const agents = await new DiscoveryClient(engine).findAgents();

    expect(issuedQuery).toMatch(/SELECT\s+DISTINCT\s+\?agent/);
    expect(agents).toEqual([{
      agentUri: duplicate.agent,
      name: 'same',
      peerId: 'peer-same',
      framework: 'OpenClaw',
      nodeRole: undefined,
      relayAddress: undefined,
      agentAddress: '0x1111111111111111111111111111111111111111',
    }]);
  });
});
