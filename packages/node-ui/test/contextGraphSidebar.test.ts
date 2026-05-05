import { describe, expect, it } from 'vitest';
import {
  belongsInContextOracle,
  canonicalAgentDid,
  creatorIsAnotherAgent,
} from '../src/ui/lib/contextGraphSidebar.js';
import type { ContextGraph } from '../src/ui/stores/projects.js';

const me = { agentDid: 'did:dkg:agent:0xAbcdEf00112233445566778899aAbBcCdDeEfFf' };

describe('contextGraphSidebar', () => {
  it('canonicalAgentDid lowercases address in DID', () => {
    expect(canonicalAgentDid('did:dkg:agent:0xABCDEF00112233445566778899AABBCCDDEeff')).toBe(
      'did:dkg:agent:0xabcdef00112233445566778899aabbccddeeff',
    );
  });

  it('creatorIsAnotherAgent when creator differs', () => {
    const cg = { id: 'x', name: 'n', creator: 'did:dkg:agent:0x0000000000000000000000000000000000000001' } as ContextGraph;
    expect(creatorIsAnotherAgent(cg, me)).toBe(true);
  });

  it('belongsInContextOracle true for other creator', () => {
    const cg = { id: 'x', name: 'n', creator: 'did:dkg:agent:0x0000000000000000000000000000000000000001' } as ContextGraph;
    expect(belongsInContextOracle(cg, me, new Set(), new Set())).toBe(true);
  });

  it('belongsInContextOracle false when same creator', () => {
    const cg = { id: 'x', name: 'n', creator: me.agentDid } as ContextGraph;
    expect(belongsInContextOracle(cg, me, new Set(), new Set())).toBe(false);
  });

  it('force-my pins project to My sidebar', () => {
    const cg = { id: 'x', name: 'n', creator: 'did:dkg:agent:0x1111111111111111111111111111111111111111' } as ContextGraph;
    const force = new Set(['x']);
    expect(belongsInContextOracle(cg, me, new Set(), force)).toBe(false);
  });
});
