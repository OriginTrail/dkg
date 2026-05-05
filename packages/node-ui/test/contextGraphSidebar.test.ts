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

  it('my: callerInvolved true (curator/participant role)', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: true,
      callerInvolved: true,
      accessPolicy: 'public',
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(true);
    expect(belongsInContextOracleSidebar(cg, id)).toBe(false);
  });

  it('not my: node subscribed only without agent role (public goes to oracle)', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: true,
      callerInvolved: false,
      accessPolicy: 'public',
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(false);
    expect(belongsInContextOracleSidebar(cg, id)).toBe(true);
  });

  it('oracle is strict: unknown accessPolicy never enters oracle', () => {
    const cg = {
      id: 'x',
      name: 'n',
      callerInvolved: false,
    } as ContextGraph;
    expect(belongsInContextOracleSidebar(cg, id)).toBe(false);
  });

  it('my: curator wallet matches (legacy daemon without callerInvolved)', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: false,
      curator: id.agentDid,
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(true);
  });

  it('creator peer alone is not my project without callerInvolved', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: false,
      callerInvolved: false,
      creator: `did:dkg:agent:${id.peerId}`,
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(false);
  });

  it('oracle: public, not mine', () => {
    const cg = {
      id: 'x',
      name: 'n',
      callerInvolved: false,
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
      callerInvolved: false,
      accessPolicy: 'private',
      creator: 'did:dkg:agent:0x2000000000000000000000000000000000000000',
    } as ContextGraph;
    expect(belongsInContextOracleSidebar(cg, id)).toBe(false);
  });
});
