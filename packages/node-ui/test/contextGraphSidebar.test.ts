import { describe, expect, it } from 'vitest';
import {
  belongsInContextOracleSidebar,
  belongsInMyProjectsSidebar,
  canonicalAgentDid,
  computeSelectableProjects,
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

  it('oracle: public, not mine, subscribed', () => {
    const cg = {
      id: 'x',
      name: 'n',
      subscribed: true,
      callerInvolved: false,
      accessPolicy: 'public',
      creator: 'did:dkg:agent:0x1000000000000000000000000000000000000000',
    } as ContextGraph;
    expect(belongsInMyProjectsSidebar(cg, id)).toBe(false);
    expect(belongsInContextOracleSidebar(cg, id)).toBe(true);
  });

  it('oracle: public, not mine, synced (alone is enough)', () => {
    const cg = {
      id: 'x',
      name: 'n',
      synced: true,
      callerInvolved: false,
      accessPolicy: 'public',
    } as ContextGraph;
    expect(belongsInContextOracleSidebar(cg, id)).toBe(true);
  });

  it('oracle: public, not mine, NEITHER subscribed nor synced — excluded as stale', () => {
    // The Oracle should NOT show graphs the daemon has only ever heard about
    // via gossip without any actual interaction. On a long-running testnet
    // node those stale entries dominate the list (hundreds of one-off
    // smoke/test CGs whose curators are long gone). A user who wants to join
    // such a CG can still paste its ID into "Join Project" directly.
    const cg = {
      id: 'x',
      name: 'n',
      callerInvolved: false,
      accessPolicy: 'public',
      creator: 'did:dkg:agent:0x1000000000000000000000000000000000000000',
    } as ContextGraph;
    expect(belongsInContextOracleSidebar(cg, id)).toBe(false);
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

describe('computeSelectableProjects (chat project picker)', () => {
  const mine1 = { id: 'm1', name: 'Mine 1', callerInvolved: true } as ContextGraph;
  const mine2 = { id: 'm2', name: 'Mine 2', callerInvolved: true } as ContextGraph;
  const notMine = { id: 'n1', name: 'Not Mine', callerInvolved: false, accessPolicy: 'public' } as ContextGraph;

  it('includes member projects and excludes non-member ones', () => {
    const out = computeSelectableProjects([mine1, notMine, mine2], id, null);
    expect(out.map((c) => c.id)).toEqual(['m1', 'm2']);
  });

  it('still surfaces the active project even when it is not a member (prepended once)', () => {
    const out = computeSelectableProjects([mine1, notMine, mine2], id, 'n1');
    expect(out.map((c) => c.id)).toEqual(['n1', 'm1', 'm2']);
  });

  it('does not duplicate the active project when it is already a member', () => {
    const out = computeSelectableProjects([mine1, notMine, mine2], id, 'm2');
    expect(out.map((c) => c.id)).toEqual(['m1', 'm2']);
  });

  it('ignores an active id that is not in the available list', () => {
    const out = computeSelectableProjects([mine1, notMine], id, 'ghost');
    expect(out.map((c) => c.id)).toEqual(['m1']);
  });

  it('null identity → only daemon-confirmed (callerInvolved) member projects', () => {
    const out = computeSelectableProjects([mine1, notMine], null, null);
    expect(out.map((c) => c.id)).toEqual(['m1']);
  });
});
