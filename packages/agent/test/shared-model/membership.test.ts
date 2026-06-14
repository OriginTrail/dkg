/**
 * Per-agent membership gate for shared-model invokes (PR #1157/#1158, B1 + #1).
 *
 * Pins the per-agent binding fix. `isAgentPeerContextGraphMember` must authorise
 * ONLY when the CLAIMED agent's curator-APPROVED delegatee-peer set
 * (`allowedDelegateePeer`, read by the canonical
 * `getContextGraphAllowedDelegateePeers` helper) contains the cryptographically
 * authenticated transport peer. It must DENY:
 *   - a peer present only via the self-asserted, pre-approval
 *     `delegationDelegateePeer` value (pending joiner) or whose delegation was
 *     removed (its `did:dkg:agent-delegation:*` subject is gone),
 *   - a request that CLAIMS an approved agent but arrives from a DIFFERENT peer
 *     than that agent's binding (impersonation),
 *   - a request that arrives from agent A's approved peer but CLAIMS agent B
 *     (multi-agent inheritance via the old union),
 *   - a request with no `agentAddress` claim at all (no union fallback).
 *
 * The decision delegates to the canonical helper, which runs one `store.query`.
 * We drive the real method logic through a stubbed `store.query` so the
 * pending-vs-approved and per-agent distinctions are asserted without a full
 * chain harness. `delegationDelegateePeer` lives on a different subject and a
 * different predicate than the helper queries, so a pending/removed peer is
 * simply absent from the returned approved set.
 */
import { describe, it, expect } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { WorkspaceCryptoMethods } from '../../src/dkg-agent-crypto.js';
import { SharedModelMethods } from '../../src/dkg-agent-shared-model.js';
import type { DKGAgent } from '../../src/dkg-agent.js';

type QueryFn = (sparql: string) => Promise<{ type: 'bindings'; bindings: Array<Record<string, string>> } | { type: 'boolean'; value: boolean }>;

// Minimal harness: an object carrying just the two prototype methods under test
// plus a stubbed store. `isAgentPeerContextGraphMember` (private) is invoked by
// name; the canonical helper it calls reads only `store.query`.
function makeAgent(query: QueryFn): {
  isMember(cg: string, agent: string | undefined, peer: string): Promise<boolean>;
} {
  const agent = {
    store: { query },
    getContextGraphAllowedDelegateePeers: WorkspaceCryptoMethods.prototype.getContextGraphAllowedDelegateePeers,
    isAgentPeerContextGraphMember: (SharedModelMethods.prototype as unknown as {
      isAgentPeerContextGraphMember(this: DKGAgent, cg: string, agent: string | undefined, peer: string): Promise<boolean>;
    }).isAgentPeerContextGraphMember,
  } as unknown as DKGAgent & {
    isAgentPeerContextGraphMember(cg: string, agent: string | undefined, peer: string): Promise<boolean>;
  };
  return { isMember: (cg, a, peer) => agent.isAgentPeerContextGraphMember(cg, a, peer) };
}

const AGENT_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const AGENT_B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const PEER_A = '12D3KooWPeerForAgentA';
const PEER_B = '12D3KooWPeerForAgentB';
const PENDING_PEER = '12D3KooWPendingJoiner';

// A store whose APPROVED-delegatee query (the only predicate the canonical
// helper reads) returns the given (agent, peer) bindings. The pending peer's
// self-asserted `delegationDelegateePeer` binding is never returned by this
// query, mirroring production where it lives on the join-request subject.
function approvedStore(bindings: Array<{ agent: string; peer: string; expiresAtMs?: number }>): QueryFn {
  return async (sparql: string) => {
    if (sparql.includes(DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER)) {
      return {
        type: 'bindings',
        bindings: bindings.map((b) => ({
          agent: `"${b.agent}"`,
          peer: `"${b.peer}"`,
          ...(b.expiresAtMs != null ? { expiresAt: `"${b.expiresAtMs}"` } : {}),
        })),
      };
    }
    return { type: 'bindings', bindings: [] };
  };
}

describe('shared-model per-agent membership gate (#1)', () => {
  it('ALLOWS the approved agent from its bound, unexpired peer', async () => {
    const agent = makeAgent(approvedStore([{ agent: AGENT_A, peer: PEER_A }]));
    expect(await agent.isMember('cg1', AGENT_A, PEER_A)).toBe(true);
  });

  it('DENIES an agent (B) that is NOT approved, even behind an approved peer', async () => {
    // Agent A is approved at PEER_A. A request that arrives via PEER_A but
    // CLAIMS agent B (who has no approved binding) is denied — the union check
    // would have allowed it.
    const agent = makeAgent(approvedStore([{ agent: AGENT_A, peer: PEER_A }]));
    expect(await agent.isMember('cg1', AGENT_B, PEER_A)).toBe(false);
  });

  it('DENIES a pending-only agent (no approved delegatee binding)', async () => {
    // The curator approved no one yet → the approved-peer query is empty even
    // though a pending join-request wrote `delegationDelegateePeer` for this
    // peer (which this gate must never read).
    const agent = makeAgent(approvedStore([]));
    expect(await agent.isMember('cg1', AGENT_A, PENDING_PEER)).toBe(false);
  });

  it('DENIES claiming an approved agent from a DIFFERENT peer (impersonation)', async () => {
    // Agent A is bound to PEER_A. An attacker on PEER_B claiming to be agent A
    // does not match A's recorded delegatee peer → denied.
    const agent = makeAgent(approvedStore([{ agent: AGENT_A, peer: PEER_A }]));
    expect(await agent.isMember('cg1', AGENT_A, PEER_B)).toBe(false);
  });

  it('DENIES a missing agentAddress (no union fallback)', async () => {
    const agent = makeAgent(approvedStore([{ agent: AGENT_A, peer: PEER_A }]));
    expect(await agent.isMember('cg1', undefined, PEER_A)).toBe(false);
    expect(await agent.isMember('cg1', '', PEER_A)).toBe(false);
  });

  it('DENIES an approved-but-EXPIRED delegatee binding', async () => {
    const agent = makeAgent(approvedStore([{ agent: AGENT_A, peer: PEER_A, expiresAtMs: Date.now() - 60_000 }]));
    expect(await agent.isMember('cg1', AGENT_A, PEER_A)).toBe(false);
  });

  it('binds each agent to ITS OWN peer — no cross-agent inheritance', async () => {
    // Two approved agents on (potentially) the same node. Each is authorised
    // only for its own (agent, peer) pair; a swap is denied.
    const agent = makeAgent(approvedStore([
      { agent: AGENT_A, peer: PEER_A },
      { agent: AGENT_B, peer: PEER_B },
    ]));
    expect(await agent.isMember('cg1', AGENT_A, PEER_A)).toBe(true);
    expect(await agent.isMember('cg1', AGENT_B, PEER_B)).toBe(true);
    // A's peer claiming B (and vice-versa) → denied.
    expect(await agent.isMember('cg1', AGENT_B, PEER_A)).toBe(false);
    expect(await agent.isMember('cg1', AGENT_A, PEER_B)).toBe(false);
  });

  it('matches the claimed agent case-insensitively (helper keys are lowercased)', async () => {
    const agent = makeAgent(approvedStore([{ agent: AGENT_A.toLowerCase(), peer: PEER_A }]));
    expect(await agent.isMember('cg1', AGENT_A.toUpperCase(), PEER_A)).toBe(true);
  });
});
