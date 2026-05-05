import { describe, expect, it } from 'vitest';
import {
  belongsInContextOracleSidebar,
  belongsInMyProjectsSidebar,
  canonicalAgentDid,
} from '../src/ui/lib/contextGraphSidebar.js';
import type { ContextGraph } from '../src/ui/stores/projects.js';

const id = { agentDid: 'did:dkg:agent:0xffffffffffffffffffffffffffffffffffffffff', peerId: 'QmLocalPeer' };

describe('contextGraphSidebar', () => {
  it('canonicalAgentDid lowercases EVM DID', () => {
    const addr = `${'a'.repeat(40)}`;
    expect(canonicalAgentDid(`did:dkg:agent:0x${addr.toUpperCase()}`)).toBe(`did:dkg:agent:0x${addr}`);
  });

  it('my: subscribed', () => {
    const cg = { id: 'x', name: 'n', subscribed: true } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(true);
    expect(belongsInContextOracleSidebar(cg, id)).toBe(false);
  });

  it('my: curator wallet matches', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: false,
      curator: id.agentDid,
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(true);
  });

  it('my: creator peer matches this node', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: false,
      creator: `did:dkg:agent:${id.peerId}`,
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(true);
  });

  it('oracle: public, not subscribed', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: false,
      accessPolicy: 'public',
      creator: 'did:dkg:agent:0x1000000000000000000000000000000000000000',
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(false);
    expect(belongsInContextOracleSidebar(cg, id)).toBe(true);
  });

  it('neither oracle: private unsolicited', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: false,
      accessPolicy: 'private',
      creator: 'did:dkg:agent:0x2000000000000000000000000000000000000000',
    } as ContextGraph;
    expect(belongsInContextOracleSidebar(cg, id)).toBe(false);
  });
});
