import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { buildAuthoritativePublicMetaQuads } from '../src/context-graph-public-meta-proof.js';
import type { ContextGraphSub, ContextGraphSubInput } from '../src/dkg-agent-types.js';
import type { Quad } from '@origintrail-official/dkg-storage';

const CG = 'dormant-admission-boundary';
const DRAFT = 'local-owner-draft';
const DRAFT_SUBJECT = 'urn:dormant-admission:local-draft';
const FOREIGN = '0x00000000000000000000000000000000000000B2';
const SELECT = 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1';
const UNAVAILABLE = [
  'finalized-name-absence-unaccepted', 'authority-circuit-open',
] as const;
const agents: DKGAgent[] = [];

interface NativeState {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  setContextGraphSubscription(id: string, next: ContextGraphSubInput, options: { persist: false }): ContextGraphSub;
  _publish(contextGraphId: string, quads: Quad[]): Promise<unknown>;
  createV10ACKProvider(contextGraphId: string): unknown;
}

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function fixture(options: {
  row?: 'identity' | 'member' | 'host';
  scope?: boolean;
  pending?: boolean;
  defined?: boolean;
} = {}) {
  const agent = await DKGAgent.create({
    name: 'DormantAdmissionBoundary',
    chainAdapter: new MockChainAdapter(),
    nodeRole: 'edge',
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: false,
    syncContextGraphs: options.scope ? [CG] : undefined,
  });
  agents.push(agent);
  // Native local/store paths need an identity, not a running daemon or transport.
  vi.spyOn(agent, 'peerId', 'get').mockReturnValue('dormant-admission-boundary-peer');
  const state = agent as unknown as NativeState;
  if (options.row) state.setContextGraphSubscription(CG, {
    subscribed: options.row === 'member',
    coreHosted: options.row === 'host',
    synced: false,
    pendingMeta: options.pending,
  }, { persist: false });
  if (options.defined) await agent.store.insert(buildAuthoritativePublicMetaQuads(CG));
  return { agent, state };
}

describe('dormant identity is distinct from native admission', () => {
  it.each([
    ['identity', false, 'denied'],
    ['host', false, 'denied'],
    ['member', false, 'allowed'],
    ['identity', true, 'allowed'],
  ] as const)('legacy private fallback for %s with explicit scope=%s is %s', async (row, scope, outcome) => {
    const { agent } = await fixture({ row, scope });
    // Only authority facts are supplied: the composed query input and native
    // precedence/fallback resolver run unchanged.
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({ kind: 'unregistered' });
    vi.spyOn(agent, 'getContextGraphAllowedPeers').mockResolvedValue(null);
    vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
    vi.spyOn(agent, 'getContextGraphAgentGateAddresses').mockResolvedValue(null);
    vi.spyOn(agent, 'getPrivateContextGraphParticipants').mockResolvedValue([]);
    await expect(agent.resolveContextGraphReadAuthority(CG)).resolves.toMatchObject({ outcome });
  });

  it.each(['member', 'identity'] as const)('pending metadata cannot authorize legacy private %s even with explicit scope', async (row) => {
    const { agent } = await fixture({ row, scope: true, pending: true });
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({ kind: 'unregistered' });
    vi.spyOn(agent, 'getContextGraphAllowedPeers').mockResolvedValue(null);
    vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
    vi.spyOn(agent, 'getContextGraphAgentGateAddresses').mockResolvedValue(null);
    vi.spyOn(agent, 'getPrivateContextGraphParticipants').mockResolvedValue([]);
    await expect(agent.resolveContextGraphReadAuthority(CG)).resolves.toMatchObject({ outcome: 'unavailable' });
  });

  for (const reason of UNAVAILABLE) {
    for (const row of [undefined, 'identity'] as const) {
      it('returns empty scoped ' + reason + ' for ' + (row ?? 'absent') + ' without local graph or admission', async () => {
        const { agent } = await fixture({ row });
        vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
          outcome: 'unavailable', source: 'registered-chain', reason,
          dependency: 'chain', metadataBootstrap: 'forbidden',
        });
        const exists = vi.spyOn(agent, 'contextGraphExists');
        const query = vi.spyOn(agent.queryEngine, 'query');
        await expect(agent.query(SELECT, { contextGraphId: CG })).resolves.toEqual({ bindings: [] });
        expect(exists).toHaveBeenCalledWith(CG, { signal: undefined });
        expect(query).not.toHaveBeenCalled();
      });
    }
    for (const row of ['member', 'host'] as const) {
      it('retains retryable ' + reason + ' for admitted ' + row + ' even without local graph', async () => {
        const { agent } = await fixture({ row });
        vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
          outcome: 'unavailable', source: 'registered-chain', reason,
          dependency: 'chain', metadataBootstrap: 'forbidden',
        });
        await expect(agent.query(SELECT, { contextGraphId: CG })).rejects.toMatchObject({
          code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true, reason,
        });
      });
    }
    it('retains retryable ' + reason + ' for actual local graph despite identity-only row', async () => {
      const { agent } = await fixture({ row: 'identity', defined: true });
      vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
        outcome: 'unavailable', source: 'registered-chain', reason,
        dependency: 'chain', metadataBootstrap: 'forbidden',
      });
      await expect(agent.query(SELECT, { contextGraphId: CG })).rejects.toMatchObject({
        code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true,
      });
    });
  }

  it.each([undefined, 'identity'] as const)('publish refuses missing actual graph for %s before ACK or signing', async (row) => {
    const { agent, state } = await fixture({ row });
    const exists = vi.spyOn(agent, 'contextGraphExists');
    const ack = vi.spyOn(state, 'createV10ACKProvider').mockImplementation(() => {
      throw new Error('ACK_BOUNDARY_REACHED');
    });
    await expect(state._publish(CG, [])).rejects.toThrow('Context graph "' + CG + '" does not exist');
    expect(exists).toHaveBeenCalledWith(CG);
    expect(ack).not.toHaveBeenCalled();
  });

  it.each(['member', 'host'] as const)('publish keeps admitted %s existence shortcut', async (row) => {
    const { agent, state } = await fixture({ row });
    const exists = vi.spyOn(agent, 'contextGraphExists');
    const ack = vi.spyOn(state, 'createV10ACKProvider').mockImplementation(() => {
      throw new Error('ACK_BOUNDARY_REACHED');
    });
    await expect(state._publish(CG, [])).rejects.toThrow('ACK_BOUNDARY_REACHED');
    expect(exists).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });

  it('publish permits an actual defined local graph with identity-only row after native existence proof', async () => {
    const { agent, state } = await fixture({ row: 'identity', defined: true });
    const exists = vi.spyOn(agent, 'contextGraphExists');
    const ack = vi.spyOn(state, 'createV10ACKProvider').mockImplementation(() => {
      throw new Error('ACK_BOUNDARY_REACHED');
    });
    await expect(state._publish(CG, [])).rejects.toThrow('ACK_BOUNDARY_REACHED');
    expect(exists).toHaveBeenCalledWith(CG);
    expect(ack).toHaveBeenCalledOnce();
  });
});

async function localWorkingMemoryFixture(allowedAgents?: string[]) {
  const agent = await DKGAgent.create({
    name: 'LocalWorkingMemoryOwner',
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: new MockChainAdapter(),
    nodeRole: 'edge',
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: false,
  });
  agents.push(agent);
  await agent.start();
  expect(agent.getDefaultAgentAddress()).toBeUndefined();
  await agent.createContextGraph({ id: CG, name: CG, private: true, allowedAgents });
  await agent.assertion.create(CG, DRAFT);
  await agent.assertion.write(CG, DRAFT, [{
    subject: DRAFT_SUBJECT, predicate: 'urn:dormant-admission:predicate', object: '"local draft"', graph: '',
  }]);
  const state = agent as unknown as NativeState;
  const wm = { contextGraphId: CG, view: 'working-memory' as const, agentAddress: agent.peerId, assertionName: DRAFT };
  return { agent, state, wm };
}

describe('local private working-memory ownership does not grant graph admission', () => {
  it('reads a real locally created peer-ID draft without an EVM identity or subscription', async () => {
    const { agent, state, wm } = await localWorkingMemoryFixture();
    expect(state.subscribedContextGraphs.get(CG)?.subscribed).toBe(false);
    expect(state.subscribedContextGraphs.get(CG)?.coreHosted).not.toBe(true);
    await expect(agent.resolveContextGraphReadAuthority(CG)).resolves.toMatchObject({
      outcome: 'denied', source: 'legacy-local', reason: 'no-read-authority',
    });
    await expect(agent.query(SELECT, wm)).resolves.toMatchObject({ bindings: [{ s: DRAFT_SUBJECT }] });
    await expect(agent.canReadContextGraph(CG)).resolves.toBe(false);
  });

  it('keeps authenticated foreign-agent working-memory isolation', async () => {
    const { agent, wm } = await localWorkingMemoryFixture();
    const query = vi.spyOn(agent.queryEngine, 'query');
    await expect(agent.query(SELECT, { ...wm, callerAgentAddress: FOREIGN })).resolves.toEqual({ bindings: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not authorize default, shared, or verifiable-memory graph reads', async () => {
    const { agent } = await localWorkingMemoryFixture();
    const query = vi.spyOn(agent.queryEngine, 'query');
    for (const view of [undefined, 'shared-working-memory', 'verifiable-memory'] as const) {
      await expect(agent.query(SELECT, { contextGraphId: CG, view })).resolves.toEqual({ bindings: [] });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('does not bypass chain authority for a numerically bound local-origin graph', async () => {
    const { agent, state, wm } = await localWorkingMemoryFixture();
    state.setContextGraphSubscription(CG, {
      ...state.subscribedContextGraphs.get(CG), onChainId: '582',
    }, { persist: false });
    await expect(agent.isLocalFirstUnregisteredContextGraph(CG)).resolves.toBe(false);
    const query = vi.spyOn(agent.queryEngine, 'query');
    await expect(agent.query(SELECT, wm)).rejects.toMatchObject({ code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not treat replicated declaration and draft RDF as local-create origin', async () => {
    const { agent: owner, wm } = await localWorkingMemoryFixture();
    const replica = await DKGAgent.create({
      name: 'WorkingMemoryReplica', chainAdapter: new MockChainAdapter(), nodeRole: 'edge',
      rfc64CatalogActivation: { enabled: false }, contextGraphSubscriptionRehydrationEnabled: false,
    });
    agents.push(replica);
    const snapshot = await owner.store.query('SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
    if (snapshot.type !== 'bindings') throw new Error('Expected native SELECT snapshot');
    await replica.store.insert(snapshot.bindings.map(({ s, p, o, g }) => ({ subject: s, predicate: p, object: o, graph: g })));
    await expect(replica.isLocalFirstUnregisteredContextGraph(CG)).resolves.toBe(false);
    const query = vi.spyOn(replica.queryEngine, 'query');
    await expect(replica.resolveContextGraphReadAuthority(CG)).resolves.toMatchObject({
      outcome: 'denied', source: 'legacy-local', reason: 'no-read-authority',
    });
    await expect(replica.query(SELECT, wm)).resolves.toEqual({ bindings: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['numeric', 'pending'] as const)('refuses a %s binding arriving during the local-owner proof', async (change) => {
    const { agent, state, wm } = await localWorkingMemoryFixture();
    const readStatus = agent.readLocalContextGraphRegistrationStatus.bind(agent);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let decisionComplete = false;
    const resolveAuthority = agent.resolveContextGraphReadAuthority.bind(agent);
    vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockImplementation(async (...args) => {
      const authority = await resolveAuthority(...args);
      decisionComplete = true;
      return authority;
    });
    vi.spyOn(agent, 'readLocalContextGraphRegistrationStatus').mockImplementation(async (id) => {
      if (decisionComplete) {
        entered();
        await held;
      }
      return readStatus(id);
    });
    const query = vi.spyOn(agent.queryEngine, 'query');
    const result = agent.query(SELECT, wm);
    try {
      await waiting;
      state.setContextGraphSubscription(CG, {
        ...state.subscribedContextGraphs.get(CG),
        ...(change === 'numeric' ? { onChainId: '582' } : { pendingMeta: true }),
      }, { persist: false });
    } finally {
      release();
    }
    await expect(result).resolves.toEqual({ bindings: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps pending metadata and an explicit private roster closed', async () => {
    const pending = await localWorkingMemoryFixture();
    pending.state.setContextGraphSubscription(CG, {
      ...pending.state.subscribedContextGraphs.get(CG), pendingMeta: true,
    }, { persist: false });
    await expect(pending.agent.query(SELECT, pending.wm)).rejects.toMatchObject({
      code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', reason: 'pending-authoritative-metadata',
    });
    const gated = await localWorkingMemoryFixture([FOREIGN]);
    await expect(gated.agent.resolveContextGraphReadAuthority(CG)).resolves.toMatchObject({
      outcome: 'denied', source: 'legacy-local', reason: 'local-agent-not-allowed',
    });
    await expect(gated.agent.query(SELECT, gated.wm)).resolves.toEqual({ bindings: [] });
  });
});
