/**
 * Curator-side P2P handler authorization + quota (PR #1158, #1 + #3).
 *
 * Drives the real `handleSharedModelInvoke` with a stubbed store + `mock`
 * provider. Pins:
 *   #1 — per-agent binding: a request is authorised iff the CLAIMED
 *        `agentAddress` is an approved member AND the transport-authenticated
 *        `fromPeerId` is among THAT agent's approved delegatee peers.
 *   #3 — quota consumed only AFTER authorization: a request denied for
 *        non-membership does not decrement the (fromPeerId-keyed) bucket.
 */
import { describe, it, expect } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { SharedModelMethods } from '../../src/dkg-agent-shared-model.js';
import { WorkspaceCryptoMethods } from '../../src/dkg-agent-crypto.js';
import type { DKGAgent } from '../../src/dkg-agent.js';
import {
  encodeInvokeRequest,
  decodeInvokeRequest,
  decodeInvokeResponse,
} from '../../src/shared-model/wire.js';

const AGENT_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const PEER_A = '12D3KooWPeerForAgentA';
const PEER_X = '12D3KooWAttackerPeer';
const SHARED_MODEL_ENABLED = 'https://dkg.network/ontology#sharedModelEnabled';

interface HarnessOpts {
  approved: Array<{ agent: string; peer: string }>;
  grantEnabled?: boolean;
  dailyQuota?: number;
}

function makeAgent(opts: HarnessOpts) {
  const proto = SharedModelMethods.prototype;
  const agent = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: {
      query: async (sparql: string) => {
        if (sparql.includes(DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER)) {
          return {
            type: 'bindings',
            bindings: opts.approved.map((b) => ({ agent: `"${b.agent}"`, peer: `"${b.peer}"` })),
          };
        }
        if (sparql.includes(SHARED_MODEL_ENABLED)) {
          return opts.grantEnabled === false
            ? { type: 'bindings', bindings: [] }
            : { type: 'bindings', bindings: [{ p: SHARED_MODEL_ENABLED, o: '"true"' }] };
        }
        return { type: 'bindings', bindings: [] };
      },
    },
    getContextGraphAllowedDelegateePeers: WorkspaceCryptoMethods.prototype.getContextGraphAllowedDelegateePeers,
    getContextGraphModelGrant: proto.getContextGraphModelGrant,
    isAgentPeerContextGraphMember: proto['isAgentPeerContextGraphMember'],
    handleSharedModelInvoke: proto.handleSharedModelInvoke,
    configureSharedModel: proto.configureSharedModel,
  } as unknown as DKGAgent;

  agent.configureSharedModel({
    provider: 'mock',
    model: 'mock-model',
    enabled: true,
    dailyRequestQuotaPerAgent: opts.dailyQuota ?? 5,
    maxPromptChars: 10_000,
    invokeTimeoutMs: 1000,
    providerTimeoutMs: 800,
  });
  return agent;
}

async function invoke(agent: DKGAgent, body: { agentAddress?: string; cg?: string }, fromPeer: string) {
  const bytes = encodeInvokeRequest({
    contextGraphId: body.cg ?? 'cg1',
    messages: [{ role: 'user', content: 'hi' }],
    agentAddress: body.agentAddress,
  });
  const out = await agent.handleSharedModelInvoke(bytes, fromPeer);
  return decodeInvokeResponse(out);
}

describe('shared-model curator handler per-agent binding (#1)', () => {
  it('ALLOWS the approved agent from its bound peer', async () => {
    const agent = makeAgent({ approved: [{ agent: AGENT_A, peer: PEER_A }] });
    const res = await invoke(agent, { agentAddress: AGENT_A }, PEER_A);
    expect(res.ok).toBe(true);
  });

  it('DENIES the approved agent claimed from a different peer (impersonation)', async () => {
    const agent = makeAgent({ approved: [{ agent: AGENT_A, peer: PEER_A }] });
    const res = await invoke(agent, { agentAddress: AGENT_A }, PEER_X);
    expect(res.ok).toBe(false);
    expect(res.denied).toMatch(/not a member/i);
  });

  it('DENIES a missing agentAddress claim', async () => {
    const agent = makeAgent({ approved: [{ agent: AGENT_A, peer: PEER_A }] });
    const res = await invoke(agent, {}, PEER_A);
    expect(res.ok).toBe(false);
    expect(res.denied).toMatch(/not a member/i);
  });
});

describe('shared-model curator handler quota accounting (#3)', () => {
  it('does NOT consume quota on a non-membership denial', async () => {
    // Quota of 1 keyed by fromPeerId. An unauthorized claim from PEER_A must
    // not burn PEER_A's bucket, so a subsequent AUTHORIZED call still succeeds.
    const agent = makeAgent({ approved: [{ agent: AGENT_A, peer: PEER_A }], dailyQuota: 1 });
    // Denied: wrong agent claim from PEER_A.
    const denied = await invoke(agent, { agentAddress: '0xNotApproved' }, PEER_A);
    expect(denied.ok).toBe(false);
    // Authorized from the SAME peer still has its full quota of 1.
    const ok = await invoke(agent, { agentAddress: AGENT_A }, PEER_A);
    expect(ok.ok).toBe(true);
  });

  it('an authorized request consumes exactly one (quota of 1 → second over cap)', async () => {
    const agent = makeAgent({ approved: [{ agent: AGENT_A, peer: PEER_A }], dailyQuota: 1 });
    expect((await invoke(agent, { agentAddress: AGENT_A }, PEER_A)).ok).toBe(true);
    const second = await invoke(agent, { agentAddress: AGENT_A }, PEER_A);
    expect(second.ok).toBe(false);
    expect(second.denied).toMatch(/quota/i);
  });
});

describe('shared-model wire agentAddress round-trip (#1)', () => {
  it('encodes/decodes agentAddress when present', () => {
    const req = {
      contextGraphId: 'cg1',
      messages: [{ role: 'user' as const, content: 'hi' }],
      agentAddress: AGENT_A,
    };
    expect(decodeInvokeRequest(encodeInvokeRequest(req))).toEqual({
      contextGraphId: 'cg1',
      messages: req.messages,
      maxTokens: undefined,
      temperature: undefined,
      agentAddress: AGENT_A,
    });
  });

  it('rejects a non-string agentAddress', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ contextGraphId: 'cg1', messages: [{ role: 'user', content: 'hi' }], agentAddress: 5 }),
    );
    expect(() => decodeInvokeRequest(bytes)).toThrow(/agentAddress/);
  });
});
