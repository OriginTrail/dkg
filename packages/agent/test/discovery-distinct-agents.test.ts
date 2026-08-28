import { describe, expect, it } from 'vitest';
import type { QueryEngine } from '@origintrail-official/dkg-query';
import {
  DiscoveryClient,
  groupDiscoveredAgentIdentityRows,
} from '../src/discovery.js';

describe('DiscoveryClient.findAgents distinct-row boundary', () => {
  it('keeps conflicting identity bindings together independently of binding order', () => {
    const canonical = {
      agentUri: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
      name: 'alpha',
      peerId: 'peer-alpha',
    };
    const conflict = { ...canonical, name: 'zeta', peerId: 'peer-zeta' };

    const expected = [{ identity: canonical.agentUri, rows: [canonical, conflict] }];
    expect(groupDiscoveredAgentIdentityRows([canonical, conflict])).toEqual(expected);
    expect(groupDiscoveredAgentIdentityRows([conflict, canonical])).toEqual(expected);
  });

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
        return {
          bindings: [
            duplicate,
            { ...duplicate, name: '"same"@en' },
            { ...duplicate, peerId: '"peer-other"' },
          ],
        };
      },
    } as unknown as QueryEngine;

    const agents = await new DiscoveryClient(engine).findAgents();

    expect(issuedQuery).toMatch(/SELECT\s+DISTINCT\s+\?agent/);
    expect(agents).toEqual([
      {
        agentUri: duplicate.agent,
        name: 'same',
        peerId: 'peer-same',
        framework: 'OpenClaw',
        nodeRole: undefined,
        relayAddress: undefined,
        agentAddress: '0x1111111111111111111111111111111111111111',
      },
      {
        agentUri: duplicate.agent,
        name: 'same',
        peerId: 'peer-other',
        framework: 'OpenClaw',
        nodeRole: undefined,
        relayAddress: undefined,
        agentAddress: '0x1111111111111111111111111111111111111111',
      },
    ]);
  });

  it('applies the caller-visible limit after normalized-row deduplication', async () => {
    let issuedQuery = '';
    const first = {
      agent: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
      name: '"same"',
      peerId: '"peer-same"',
    };
    const engine = {
      query: async (sparql: string) => {
        issuedQuery = sparql;
        return {
          bindings: [
            first,
            { ...first, name: '"same"^^<http://www.w3.org/2001/XMLSchema#string>' },
            {
              agent: 'did:dkg:agent:0x2222222222222222222222222222222222222222',
              name: '"second"',
              peerId: '"peer-second"',
            },
          ],
        };
      },
    } as unknown as QueryEngine;

    const agents = await new DiscoveryClient(engine).findAgents({ limit: 2 });

    expect(issuedQuery).not.toMatch(/LIMIT\s+2/);
    expect(agents.map((agent) => agent.peerId)).toEqual(['peer-same', 'peer-second']);
  });
});
