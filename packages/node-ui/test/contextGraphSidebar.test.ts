import { describe, expect, it } from 'vitest';
import {
  belongsInContextOracle,
  canonicalAgentDid,
  creatorIsAnotherAgent,
} from '../src/ui/lib/contextGraphSidebar.js';
import type { ContextGraph } from '../src/ui/stores/projects.js';

const me = {
  agentDid: 'did:dkg:agent:0xAbcdEf00112233445566778899aAbBcCdDeEfFf',
  peerId: 'QmPeerNodeCreator',
};

describe('contextGraphSidebar', () => {
  it('canonicalAgentDid lowercases address in DID', () => {
    const addr = `${'A'.repeat(40)}`;
    expect(canonicalAgentDid(`did:dkg:agent:0x${addr}`)).toBe(`did:dkg:agent:0x${addr.toLowerCase()}`);
  });

  it('canonicalAgentDid preserves peer-id suffix case', () => {
    expect(canonicalAgentDid('did:dkg:agent:QmPeerNodeCreator')).toBe(
      'did:dkg:agent:QmPeerNodeCreator',
    );
  });

  it('creatorIsAnotherAgent false when creator matches peer DID (daemon DKG_CREATOR)', () => {
    const cg = { id: 'x', name: 'n', creator: 'did:dkg:agent:QmPeerNodeCreator' } as ContextGraph;
    expect(creatorIsAnotherAgent(cg, me)).toBe(false);
  });

  it('creatorIsAnotherAgent when creator differs', () => {
    const cg = { id: 'x', name: 'n', creator: 'did:dkg:agent:0x0000000000000000000000000000000000000001' } as ContextGraph;
    expect(creatorIsAnotherAgent(cg, me)).toBe(true);
  });

  it('belongsInContextOracle true for other creator', () => {
    const cg = { id: 'x', name: 'n', creator: 'did:dkg:agent:0x0000000000000000000000000000000000000001' } as ContextGraph;
    expect(belongsInContextOracle(cg, me, new Set(), new Set())).toBe(true);
  });

  it('belongsInContextOracle false when same wallet creator', () => {
    const cg = { id: 'x', name: 'n', creator: me.agentDid } as ContextGraph;
    expect(belongsInContextOracle(cg, me, new Set(), new Set())).toBe(false);
  });

  it('force-my pins project to My sidebar', () => {
    const cg = { id: 'x', name: 'n', creator: 'did:dkg:agent:0x1111111111111111111111111111111111111111' } as ContextGraph;
    const force = new Set(['x']);
    expect(belongsInContextOracle(cg, me, new Set(), force)).toBe(false);
  });
});
