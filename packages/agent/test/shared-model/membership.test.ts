/**
 * Membership gate for shared-model invokes (PR #1157 B1).
 *
 * Pins the auth fix: `isPeerContextGraphMember` must authorise ONLY peers that
 * the curator has APPROVED (the `allowedDelegateePeer` binding read by the
 * canonical `getContextGraphAllowedDelegateePeers` helper), and must DENY a
 * peer that is present only via the self-asserted, pre-approval
 * `delegationDelegateePeer` value or whose delegation has been removed.
 *
 * The decision delegates entirely to the canonical helper, which in turn runs
 * one `store.query`. We drive the real method logic through a stubbed
 * `store.query` so the pending-vs-approved distinction is asserted without a
 * full chain harness. `delegationDelegateePeer` lives on a different subject
 * and a different predicate than the helper queries, so a pending/removed peer
 * is simply absent from the returned approved set.
 */
import { describe, it, expect } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { WorkspaceCryptoMethods } from '../../src/dkg-agent-crypto.js';
import { SharedModelMethods } from '../../src/dkg-agent-shared-model.js';
import type { DKGAgent } from '../../src/dkg-agent.js';

type QueryFn = (sparql: string) => Promise<{ type: 'bindings'; bindings: Array<Record<string, string>> } | { type: 'boolean'; value: boolean }>;

// Minimal harness: an object carrying just the two prototype methods under
// test plus a stubbed store. `isPeerContextGraphMember` (private) is invoked by
// name; the canonical helper it calls reads only `store.query`.
function makeAgent(query: QueryFn): { isMember(cg: string, peer: string): Promise<boolean> } {
  const agent = {
    store: { query },
    getContextGraphAllowedDelegateePeers: WorkspaceCryptoMethods.prototype.getContextGraphAllowedDelegateePeers,
    isPeerContextGraphMember: (SharedModelMethods.prototype as unknown as {
      isPeerContextGraphMember(this: DKGAgent, cg: string, peer: string): Promise<boolean>;
    }).isPeerContextGraphMember,
  } as unknown as DKGAgent & { isPeerContextGraphMember(cg: string, peer: string): Promise<boolean> };
  return { isMember: (cg, peer) => agent.isPeerContextGraphMember(cg, peer) };
}

const APPROVED_PEER = '12D3KooWApprovedMember';
const PENDING_PEER = '12D3KooWPendingJoiner';

// A store whose APPROVED-delegatee query (the only predicate the canonical
// helper reads) returns exactly `approvedPeers`. The pending peer's
// self-asserted `delegationDelegateePeer` binding is never returned by this
// query, mirroring production where it lives on the join-request subject.
function approvedStore(approvedPeers: string[], expiresAtMs?: number): QueryFn {
  return async (sparql: string) => {
    if (sparql.includes(DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER)) {
      return {
        type: 'bindings',
        bindings: approvedPeers.map((peer) => ({
          agent: '"0xCuratorApprovedAgent"',
          peer: `"${peer}"`,
          ...(expiresAtMs != null ? { expiresAt: `"${expiresAtMs}"` } : {}),
        })),
      };
    }
    return { type: 'bindings', bindings: [] };
  };
}

describe('shared-model membership gate (B1)', () => {
  it('ALLOWS an approved, unexpired delegatee peer', async () => {
    const agent = makeAgent(approvedStore([APPROVED_PEER]));
    expect(await agent.isMember('cg1', APPROVED_PEER)).toBe(true);
  });

  it('DENIES a peer present only via the pending delegationDelegateePeer binding', async () => {
    // The curator approved no one yet → the approved-peer query is empty even
    // though a pending join-request wrote `delegationDelegateePeer` for this
    // peer (which this gate must never read).
    const agent = makeAgent(approvedStore([]));
    expect(await agent.isMember('cg1', PENDING_PEER)).toBe(false);
  });

  it('DENIES a removed peer (its agent-delegation subject is gone)', async () => {
    // removeAgentFromContextGraph deletes the `did:dkg:agent-delegation:*`
    // subject, so the approved-peer query returns nothing for it.
    const agent = makeAgent(approvedStore([]));
    expect(await agent.isMember('cg1', APPROVED_PEER)).toBe(false);
  });

  it('DENIES an approved-but-EXPIRED delegatee peer', async () => {
    const agent = makeAgent(approvedStore([APPROVED_PEER], Date.now() - 60_000));
    expect(await agent.isMember('cg1', APPROVED_PEER)).toBe(false);
  });

  it('authorises across multiple approving agents (flattened set)', async () => {
    const store: QueryFn = async (sparql) => {
      if (sparql.includes(DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER)) {
        return {
          type: 'bindings',
          bindings: [
            { agent: '"0xAgentA"', peer: '"12D3KooWPeerA"' },
            { agent: '"0xAgentB"', peer: `"${APPROVED_PEER}"` },
          ],
        };
      }
      return { type: 'bindings', bindings: [] };
    };
    const agent = makeAgent(store);
    expect(await agent.isMember('cg1', APPROVED_PEER)).toBe(true);
    expect(await agent.isMember('cg1', '12D3KooWPeerA')).toBe(true);
    expect(await agent.isMember('cg1', PENDING_PEER)).toBe(false);
  });
});
