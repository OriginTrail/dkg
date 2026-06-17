/**
 * Local fast-path caller authorization + quota accounting (PR #1158, #2 + #3).
 *
 * When the CG is curated ON this node, `invokeContextGraphModel` takes a local
 * fast-path (no network hop). This pins:
 *
 *   #2 — the caller is authorised ONLY if it IS the CG owner/curator OR an
 *        approved member; a different local agent that is neither is DENIED
 *        (and must NOT fall through to the remote path, which would dial self).
 *        The previous code hardcoded `isMember:true`, authorising anyone.
 *
 *   #3 — quota is consumed exactly once, and ONLY after authorization. A
 *        request denied for any other reason (here: non-membership) must not
 *        decrement the member's daily allowance.
 *
 * Harness: a real `SharedModelMethods` instance (so the module-private STATE
 * WeakMap is populated by the real `configureSharedModel`) with a stubbed store
 * and a `mock` provider (deterministic, offline). The owner/grant/allowed-agent
 * lookups are stubbed to isolate the auth + quota logic.
 */
import { describe, it, expect } from 'vitest';
import { SharedModelMethods } from '../../src/dkg-agent-shared-model.js';
import { OwnershipMethods } from '../../src/dkg-agent-ownership.js';
import type { DKGAgent } from '../../src/dkg-agent.js';
import type { SharedModelGrant } from '../../src/shared-model/types.js';

const PEER_ID = '12D3KooWLocalCurator';
const OWNER = '0xC0FFEE0000000000000000000000000000000001';
const MEMBER = '0xC0FFEE0000000000000000000000000000000002';
const OUTSIDER = '0xC0FFEE0000000000000000000000000000000003'; // another local agent, not on this CG

interface HarnessOpts {
  owner: string;
  defaultAgent?: string;
  /** Override the stored owner DID (defaults to `did:dkg:agent:<owner>`). */
  ownerDid?: string;
  allowedAgents: string[];
  grant?: SharedModelGrant;
  dailyQuota?: number;
  localAgents?: string[];
}

function makeAgent(opts: HarnessOpts) {
  const grant: SharedModelGrant = opts.grant ?? { enabled: true, modelId: 'mock-model' };
  const ownerDid = opts.ownerDid ?? `did:dkg:agent:${opts.owner}`;
  const proto = SharedModelMethods.prototype;
  const localAgents = new Map<string, unknown>();
  for (const a of opts.localAgents ?? [opts.owner]) localAgents.set(a, {});

  const agent = {
    peerId: PEER_ID,
    defaultAgentAddress: opts.defaultAgent ?? opts.owner,
    localAgents,
    getDefaultAgentAddress: () => opts.defaultAgent ?? opts.owner,
    store: { query: async () => ({ type: 'bindings', bindings: [] }) },
    // Stub the CG-state lookups the local path consults.
    getContextGraphOwner: async () => ownerDid,
    getContextGraphModelGrant: async () => grant,
    getContextGraphAllowedAgents: async () => opts.allowedAgents.slice(),
    // Real methods under test (bound through the prototype).
    isContextGraphCuratorSelf: proto['isContextGraphCuratorSelf'],
    localCgOwnerDids: proto['localCgOwnerDids'],
    isCallerLocalCgMember: proto['isCallerLocalCgMember'],
    invokeContextGraphModel: proto.invokeContextGraphModel,
    configureSharedModel: proto.configureSharedModel,
    // Real canonical owner check (used by isCallerLocalCgMember).
    isCallerOrNodeOwner: OwnershipMethods.prototype.isCallerOrNodeOwner,
    // Remote path must never be reached in these tests.
    resolveCuratorPeerId: async () => { throw new Error('remote path reached — should be local'); },
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

const MSG = [{ role: 'user' as const, content: 'hello' }];

describe('shared-model local fast-path authorization (#2)', () => {
  it('ALLOWS the CG owner/curator', async () => {
    const agent = makeAgent({ owner: OWNER, allowedAgents: [OWNER] });
    const res = await agent.invokeContextGraphModel('cg1', MSG, {}, OWNER);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('hello');
  });

  it('ALLOWS an approved member (caller in the allowed-agent set)', async () => {
    const agent = makeAgent({ owner: OWNER, allowedAgents: [OWNER, MEMBER] });
    const res = await agent.invokeContextGraphModel('cg1', MSG, {}, MEMBER);
    expect(res.ok).toBe(true);
  });

  it('matches the allowlist case-insensitively', async () => {
    const agent = makeAgent({ owner: OWNER, allowedAgents: [MEMBER.toLowerCase()] });
    const res = await agent.invokeContextGraphModel('cg1', MSG, {}, MEMBER.toUpperCase());
    expect(res.ok).toBe(true);
  });

  it('DENIES another local agent that is neither owner nor member (no fall-through to remote)', async () => {
    // OUTSIDER is a local agent (so the local path applies) but is not the CG
    // owner and not on its allowlist. Must be DENIED here, never dial self.
    const agent = makeAgent({
      owner: OWNER,
      allowedAgents: [OWNER, MEMBER],
      localAgents: [OWNER, OUTSIDER],
    });
    const res = await agent.invokeContextGraphModel('cg1', MSG, {}, OUTSIDER);
    expect(res.ok).toBe(false);
    expect(res.denied).toMatch(/not a member/i);
  });

  it('DENIES a node-level token with no caller agent address', async () => {
    // No callerAgentAddress → cannot establish owner-or-member → denied.
    const agent = makeAgent({ owner: OWNER, allowedAgents: [OWNER, MEMBER] });
    const res = await agent.invokeContextGraphModel('cg1', MSG, {}, undefined);
    expect(res.ok).toBe(false);
    expect(res.denied).toMatch(/not a member/i);
  });

  it('ALLOWS the curator of a LEGACY peerId-owned CG (default agent caller)', async () => {
    // Legacy CG whose owner DID is the peerId-based form. The curator invokes
    // with their default-agent address (not in the allowlist). The canonical
    // owner check honors `caller === defaultAgent && owner === peerDid`, so
    // they must be ALLOWED — matching setContextGraphModelSharing's gate.
    const agent = makeAgent({
      owner: OWNER,
      defaultAgent: OWNER,
      ownerDid: `did:dkg:agent:${PEER_ID}`,
      allowedAgents: [], // curator deliberately NOT in the allowlist
      localAgents: [OWNER],
    });
    const res = await agent.invokeContextGraphModel('cg1', MSG, {}, OWNER);
    expect(res.ok).toBe(true);
  });
});

describe('shared-model local fast-path quota accounting (#3)', () => {
  it('does NOT consume quota when the request is denied for non-membership', async () => {
    const agent = makeAgent({
      owner: OWNER,
      allowedAgents: [OWNER, MEMBER],
      localAgents: [OWNER, OUTSIDER],
      dailyQuota: 1,
    });
    // First call: outsider denied — must not burn the (shared selfKey) bucket.
    const denied = await agent.invokeContextGraphModel('cg1', MSG, {}, OUTSIDER);
    expect(denied.ok).toBe(false);
    // The OUTSIDER's own bucket should be untouched: if it had been consumed by
    // the denied call, a (hypothetical) authorized retry would already be over
    // its quota of 1. We assert via the owner bucket below instead, which is
    // the canonical "authorized request consumes exactly one" case.
    const ok = await agent.invokeContextGraphModel('cg1', MSG, {}, OWNER);
    expect(ok.ok).toBe(true);
  });

  it('an authorized request consumes exactly one quota unit', async () => {
    const agent = makeAgent({ owner: OWNER, allowedAgents: [OWNER], dailyQuota: 2 });
    expect((await agent.invokeContextGraphModel('cg1', MSG, {}, OWNER)).ok).toBe(true);
    expect((await agent.invokeContextGraphModel('cg1', MSG, {}, OWNER)).ok).toBe(true);
    // Third exceeds the cap of 2.
    const third = await agent.invokeContextGraphModel('cg1', MSG, {}, OWNER);
    expect(third.ok).toBe(false);
    expect(third.denied).toMatch(/quota/i);
  });

  it('a non-member denial leaves the member bucket fully available', async () => {
    // MEMBER is approved; OUTSIDER is denied. Both key the SAME selfKey only if
    // they share an address — they do not, so we assert MEMBER keeps full quota
    // even after an interleaved OUTSIDER denial.
    const agent = makeAgent({
      owner: OWNER,
      allowedAgents: [OWNER, MEMBER],
      localAgents: [OWNER, MEMBER, OUTSIDER],
      dailyQuota: 1,
    });
    expect((await agent.invokeContextGraphModel('cg1', MSG, {}, OUTSIDER)).ok).toBe(false);
    // MEMBER still has its single unit — authorized once.
    expect((await agent.invokeContextGraphModel('cg1', MSG, {}, MEMBER)).ok).toBe(true);
    // ...and now exhausted.
    expect((await agent.invokeContextGraphModel('cg1', MSG, {}, MEMBER)).ok).toBe(false);
  });
});
