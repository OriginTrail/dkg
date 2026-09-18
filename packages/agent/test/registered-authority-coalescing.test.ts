import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type { RegisteredContextGraphAuthority } from '../src/registered-context-graph-authority.js';

const MEMBER = '0x0000000000000000000000000000000000000001';
const NEW_MEMBER = '0x0000000000000000000000000000000000000002';
const CG = 'registered-private';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const privateAuthority = (agents: string[]): RegisteredContextGraphAuthority => ({
  kind: 'private',
  onChainId: 7n,
  participantAgents: agents,
});

// The real fresh path never issues work on an already-aborted signal: every
// bounded read short-circuits into a fail-closed `unavailable` value. A fake
// that ignored the signal would hide exactly the contract these tests pin.
const abortedAsUnavailable = (signal: AbortSignal | undefined): RegisteredContextGraphAuthority | null =>
  (signal?.aborted === true
    ? { kind: 'unavailable', onChainId: 7n, reason: 'chain-access-policy-unavailable', detail: 'aborted' }
    : null);

async function createAgent(): Promise<{ agent: DKGAgent; chain: MockChainAdapter }> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name: 'RegisteredAuthorityCoalescing',
    chainAdapter: chain,
  });
  vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
    .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
  vi.spyOn(agent, 'resolveLiveOnChainAccessPolicyState')
    .mockResolvedValue({ kind: 'available', accessPolicy: 1 });
  return { agent, chain };
}

describe('registered authority resolution coalesces concurrent identical callers', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  it('issues ONE chain roster read for many simultaneous resolutions of one graph', async () => {
    const created = await createAgent();
    agent = created.agent;
    const gate = deferred<string[]>();
    const roster = vi.spyOn(created.chain, 'getContextGraphParticipantAgents')
      .mockImplementation(() => gate.promise);

    // Measured shape of the defect: ~40 identical resolutions per second for a
    // single context graph, each issuing its own three eth_calls.
    const callers = Array.from({ length: 25 }, () => agent!.resolveRegisteredContextGraphAuthority(CG));
    await vi.waitFor(() => expect(roster).toHaveBeenCalledTimes(1));
    gate.resolve([MEMBER]);

    const results = await Promise.all(callers);
    expect(results).toHaveLength(25);
    for (const result of results) {
      expect(result).toMatchObject({ kind: 'private', participantAgents: [MEMBER] });
    }
    expect(roster).toHaveBeenCalledTimes(1);
  });

  it('is not a cache: a resolution that has settled is never handed to a later caller', async () => {
    const created = await createAgent();
    agent = created.agent;
    const roster = vi.spyOn(created.chain, 'getContextGraphParticipantAgents')
      .mockResolvedValue([MEMBER]);

    await agent.resolveRegisteredContextGraphAuthority(CG);
    await agent.resolveRegisteredContextGraphAuthority(CG);

    // Every caller that is not simultaneous with another still reads the chain.
    expect(roster).toHaveBeenCalledTimes(2);
  });

  it('does not share a read between callers whose options change the answer', async () => {
    const created = await createAgent();
    agent = created.agent;
    const gate = deferred<string[]>();
    const roster = vi.spyOn(created.chain, 'getContextGraphParticipantAgents')
      .mockImplementation(() => gate.promise);

    const fresh = agent.resolveRegisteredContextGraphAuthority(CG);
    const cachedRosterAllowed = agent.resolveRegisteredContextGraphAuthority(CG, { allowCachedRoster: true });
    // Both must go to chain: a cached-roster caller must never be handed a
    // fresh-roster caller's read, or vice versa, because they are different
    // questions with different security contracts.
    await vi.waitFor(() => expect(roster).toHaveBeenCalledTimes(2));
    gate.resolve([MEMBER]);
    await Promise.all([fresh, cachedRosterAllowed]);
  });

  it('keeps the shared read alive when one of several waiters aborts', async () => {
    const created = await createAgent();
    agent = created.agent;
    const sharedSignals: AbortSignal[] = [];
    const gate = deferred<RegisteredContextGraphAuthority>();
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthorityFreshV1')
      .mockImplementation(async (_cg, options) => {
        const shortCircuit = abortedAsUnavailable(options?.signal);
        if (shortCircuit !== null) return shortCircuit;
        sharedSignals.push(options?.signal as AbortSignal);
        return gate.promise;
      });

    const impatient = new AbortController();
    const abortedCaller = agent.resolveRegisteredContextGraphAuthority(CG, { signal: impatient.signal });
    const patientCaller = agent.resolveRegisteredContextGraphAuthority(CG);
    await vi.waitFor(() => expect(sharedSignals).toHaveLength(1));

    impatient.abort(new Error('caller gave up'));
    // Pre-coalescing contract: an aborted caller gets a fail-closed VALUE, not
    // a rejection — the same one its own aborted read would have produced.
    await expect(abortedCaller).resolves.toMatchObject({ kind: 'unavailable' });
    // The read was started on its OWN signal, not the impatient caller's: the
    // patient caller must still be served by it, and no second read started.
    expect(sharedSignals).toHaveLength(1);
    expect(sharedSignals[0].aborted).toBe(false);

    gate.resolve(privateAuthority([MEMBER]));
    await expect(patientCaller).resolves.toMatchObject({ kind: 'private', participantAgents: [MEMBER] });
  });

  it('abandons the shared read once its last waiter has left', async () => {
    const created = await createAgent();
    agent = created.agent;
    const sharedSignals: AbortSignal[] = [];
    const gate = deferred<RegisteredContextGraphAuthority>();
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthorityFreshV1')
      .mockImplementation(async (_cg, options) => {
        const shortCircuit = abortedAsUnavailable(options?.signal);
        if (shortCircuit !== null) return shortCircuit;
        sharedSignals.push(options?.signal as AbortSignal);
        return gate.promise;
      });

    const only = new AbortController();
    const caller = agent.resolveRegisteredContextGraphAuthority(CG, { signal: only.signal });
    await vi.waitFor(() => expect(sharedSignals).toHaveLength(1));
    only.abort(new Error('nobody is waiting'));
    await expect(caller).resolves.toMatchObject({ kind: 'unavailable' });

    // No orphaned chain work: with nobody left to receive it, the read is cancelled.
    await vi.waitFor(() => expect(sharedSignals[0].aborted).toBe(true));
    gate.resolve(privateAuthority([MEMBER]));
  });

  it('a REAL invite drops a resolution that was in flight when the roster changed', async () => {
    // Goes through the production mutation path rather than the helper, so
    // this fails if the invalidation is ever unwired from the commit.
    const contextGraphId = 'coalesced-during-invite';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoalescedDuringInvite', chainAdapter: chain });
    const ownerRecord = await agent.registerAgent('Invite owner');
    const memberRecord = await agent.registerAgent('Invited member');
    await agent.markDefaultAgent(ownerRecord.agentAddress);
    await agent.start();
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Coalesced during invite',
      accessPolicy: 1,
      callerAgentAddress: ownerRecord.agentAddress,
    });
    await agent.registerContextGraph(contextGraphId, { callerAgentAddress: ownerRecord.agentAddress });

    const realAdd = chain.addContextGraphParticipantAgent.bind(chain);
    const realRoster = chain.getContextGraphParticipantAgents.bind(chain);
    const addGate = deferred<void>();
    vi.spyOn(chain, 'addContextGraphParticipantAgent').mockImplementation(async (...args) => {
      await addGate.promise;
      return realAdd(...args);
    });
    // The next roster read after this flag flips captures the roster as it is
    // at that moment (pre-mutation) and only hands it back once released.
    let captureNext = false;
    const releaseSnapshot = deferred<void>();
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockImplementation(async (id) => {
      if (!captureNext) return realRoster(id);
      captureNext = false;
      const snapshot = await realRoster(id);
      await releaseSnapshot.promise;
      return snapshot;
    });

    const invite = agent.inviteAgentToContextGraph(
      contextGraphId, memberRecord.agentAddress, ownerRecord.agentAddress,
    );
    // Let the invite finish its own pre-mutation authority read and park on
    // the chain transaction, then start an unrelated resolution mid-mutation.
    await vi.waitFor(() => expect(vi.mocked(chain.addContextGraphParticipantAgent)).toHaveBeenCalled());
    captureNext = true;
    const during = agent.resolveRegisteredContextGraphAuthority(contextGraphId);
    await vi.waitFor(() => expect(captureNext).toBe(false));

    addGate.resolve();
    await invite;
    releaseSnapshot.resolve();

    // The snapshot predates the invite. Served as-is it would omit the member;
    // the commit's invalidation forces a re-read that sees the new roster.
    await expect(during).resolves.toMatchObject({
      kind: 'private',
      participantAgents: expect.arrayContaining([memberRecord.agentAddress]),
    });
  });

  it('a local membership mutation stops later callers joining a pre-mutation read', async () => {
    const created = await createAgent();
    agent = created.agent;
    const preMutation = deferred<RegisteredContextGraphAuthority>();
    let freshReads = 0;
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthorityFreshV1')
      .mockImplementation(async () => {
        freshReads += 1;
        return freshReads === 1 ? preMutation.promise : privateAuthority([MEMBER, NEW_MEMBER]);
      });

    const before = agent.resolveRegisteredContextGraphAuthority(CG);
    await vi.waitFor(() => expect(freshReads).toBe(1));

    // The node adds NEW_MEMBER on chain. The read above began before that, so a
    // caller arriving now must not be handed its (about-to-be-stale) answer.
    agent.invalidateRegisteredAuthorityFlightV1(CG);
    const after = agent.resolveRegisteredContextGraphAuthority(CG);

    await expect(after).resolves.toMatchObject({ participantAgents: [MEMBER, NEW_MEMBER] });
    expect(freshReads).toBe(2);

    preMutation.resolve(privateAuthority([MEMBER]));
    // The initiator of the dropped read is never handed the pre-mutation
    // roster and never sees a synthetic error: it re-reads after the mutation.
    await expect(before).resolves.toMatchObject({ participantAgents: [MEMBER, NEW_MEMBER] });
    expect(freshReads).toBe(3);
  });
});
