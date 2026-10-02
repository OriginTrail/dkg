/**
 * Resolving a Context Graph's on-chain numeric id (`32`, `#32`) on a real agent
 * over a mock chain shaped like Gnosis mainnet on 2026-09-23: Context Graph #32
 * is public, publish policy 0, and was created long before this node booted.
 *
 * Before this change `dkg subscribe 32` kept a subscription keyed "32", bound
 * to on-chain 32. Its gossip topics and wire id derived from keccak256("32"),
 * which matches nothing, and RFC-64 rejected its finalized evidence as an
 * "invalid identity". The number must resolve to the row the chain's name hash
 * binds instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MOCK_DEFAULT_SIGNER, MockChainAdapter } from '@origintrail-official/dkg-chain';

import {
  DKGAgent,
  refusesPrivateContextGraphByOnChainId,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionStore,
  type ResolvedContextGraphOnChainId,
} from '../src/index.js';

const CLEARTEXT = 'gnosis-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const NUMBER_HASH = ethers.keccak256(ethers.toUtf8Bytes('32')).toLowerCase();

interface Graph32 {
  accessPolicy?: 0 | 1;
  nameHash?: string | null;
  active?: boolean;
}

/** More blocks than the live `contextGraphDiscovery` lane looks back on a cold start. */
const BEYOND_LIVE_LOOKBACK_BLOCKS = 600;

/**
 * Context Graphs #1..#31 belong to others; #32 is the graph under test. All
 * of them predate the node's live event tail, as on mainnet.
 */
async function chainWithGraph32(graph: Graph32 = {}): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  // A real RPC reports a head, so the live lane seeds near it instead of
  // replaying from genesis.
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  for (let id = 1; id < 32; id++) {
    await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(`other-graph-${id}`)),
    } as never);
  }
  const nameHash = graph.nameHash === undefined ? NAME_HASH : graph.nameHash;
  const created = await chain.createOnChainContextGraph({
    accessPolicy: graph.accessPolicy ?? 0,
    publishPolicy: 0,
    ...(nameHash === null ? {} : { nameHash }),
  } as never);
  expect(created.contextGraphId).toBe(32n);
  if (graph.active === false) chain.getContextGraph(32n)!.active = false;
  for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();
  return chain;
}

function memorySubscriptionStore(rows: ContextGraphSubscriptionRecord[] = []) {
  const records = new Map(rows.map((row) => [row.id, { ...row }]));
  const store: ContextGraphSubscriptionStore = {
    loadAll: async () => [...records.values()].map((row) => ({ ...row })),
    save: async (record) => { records.set(record.id, { ...record }); },
    delete: async (contextGraphId) => { records.delete(contextGraphId); },
  };
  return { store, records };
}

const agents: DKGAgent[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (agents.length > 0) await agents.pop()!.stop().catch(() => {});
});

async function startAgent(
  chain: MockChainAdapter | undefined,
  options: {
    store?: ContextGraphSubscriptionStore;
    syncContextGraphs?: string[];
    /** Chain authority read budgets, in ms. */
    budgets?: { request: number; cold: number };
  } = {},
): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'OnChainIdEdge',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    ...(chain === undefined ? {} : { chainAdapter: chain }),
    rfc64CatalogActivation: { enabled: false },
    ...(options.store ? { contextGraphSubscriptionStore: options.store } : {}),
    ...(options.syncContextGraphs ? { syncContextGraphs: options.syncContextGraphs } : {}),
    ...(options.budgets
      ? {
          chainConfig: {
            rpcUrl: 'http://127.0.0.1:0',
            hubAddress: ethers.ZeroAddress,
            authorityReadTimeoutMs: options.budgets.request,
            authorityColdResolutionTimeoutMs: options.budgets.cold,
          },
        }
      : {}),
  });
  agents.push(agent);
  await agent.start();
  if (chain !== undefined) await agent.awaitInitialChainPoll();
  return agent;
}

/** The internals this suite inspects; they are protected on the agent. */
function internals(agent: DKGAgent) {
  return agent as unknown as {
    subscribedContextGraphs: Map<string, ReturnType<DKGAgent['getSubscribedContextGraphs']> extends ReadonlyMap<string, infer V> ? V : never>;
    wireIdToLocalCgId: Map<string, string>;
    onChainContextGraphFacts: Map<string, unknown>;
    config: { syncContextGraphs?: string[] };
  };
}

function rowIds(agent: DKGAgent): string[] {
  return [...agent.getSubscribedContextGraphs().keys()];
}

/** What the pre-fix subscribe route did with `dkg subscribe 32`. */
function subscribeTheNumber(agent: DKGAgent, syncMode: 'on-demand' | 'always-on' = 'always-on') {
  agent.subscribeToContextGraph('32', { syncMode, onChainId: '32' });
  expect(agent.getSubscribedContextGraphs().get('32')).toMatchObject({ subscribed: true, onChainId: '32' });
}

/** Finalized RFC-64 authority evidence for on-chain #32, as the scheduled batch builds it. */
function finalizedEvidenceFor32() {
  return {
    kind: 'finalized-evidence' as const,
    evidence: {
      contextGraphAuthorityIndexId: '32',
      batchTargetIds: ['32'],
      snapshot: {
        chainId: 'mock:31337',
        governanceContract: `0x${'c6'.repeat(20)}`,
        contextGraphId: '32',
        owner: MOCK_DEFAULT_SIGNER,
        active: true,
        accessPolicy: 0,
        publishPolicy: 0,
        publishAuthority: null,
        publishAuthorityAccountId: '0',
        participantAgents: [],
        nameHash: NAME_HASH,
        ownershipEra: '0',
        policyVersion: '1',
        rosterVersion: '1',
        sourceBlockNumber: '1',
        sourceBlockHash: `0x${'ab'.repeat(32)}`,
      },
    },
  } as never;
}

describe('resolving an on-chain Context Graph id', () => {
  it('maps 32 and #32 to the row discovery staged, with no chain read and no row keyed "32"', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain);
    await agent.discoverContextGraphsFromStorage();
    const read = vi.spyOn(chain, 'readContextGraphStorageRange');

    for (const reference of ['32', '#32', 32]) {
      await expect(agent.resolveContextGraphOnChainIdReference(reference)).resolves.toEqual({
        kind: 'resolved',
        onChainId: '32',
        nameHash: NAME_HASH,
        contextGraphId: NAME_HASH,
        private: false,
      });
    }
    expect(read).not.toHaveBeenCalled();
    expect(rowIds(agent)).not.toContain('32');
    // Not an on-chain id: callers use it as given.
    for (const reference of ['acme', NAME_HASH, '032', '#0', undefined, { id: 32 }]) {
      await expect(agent.resolveContextGraphOnChainIdReference(reference)).resolves.toEqual({ kind: 'as-given' });
    }
  });

  it('looks up the row an on-chain id names without reading the chain', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain);
    await agent.discoverContextGraphsFromStorage();
    const read = vi.spyOn(chain, 'readContextGraphStorageRange');

    for (const reference of ['32', '#32', 32]) {
      expect(agent.lookupContextGraphOnChainIdReference(reference)).toEqual({
        kind: 'held',
        onChainId: '32',
        contextGraphId: NAME_HASH,
        nameHash: NAME_HASH,
      });
    }
    // A graph this node holds no row for is not read from the chain either.
    expect(agent.lookupContextGraphOnChainIdReference('#77')).toEqual({ kind: 'not-held', onChainId: '77' });
    for (const reference of ['acme', NAME_HASH, '#', 0]) {
      expect(agent.lookupContextGraphOnChainIdReference(reference)).toEqual({ kind: 'as-given' });
    }
    // A subscription keyed by the bare number wins; `#` never keys a row.
    agent.subscribeToContextGraph('32', { syncMode: 'on-demand' });
    expect(agent.lookupContextGraphOnChainIdReference('32')).toEqual({ kind: 'as-given' });
    expect(agent.lookupContextGraphOnChainIdReference('#32')).toMatchObject({ kind: 'held', contextGraphId: NAME_HASH });
    expect(read).not.toHaveBeenCalled();
  });

  it('finds the row by its own bound commitment when no chain facts are loaded yet', async () => {
    const agent = await startAgent(await chainWithGraph32());
    await agent.resolveContextGraphOnChainIdReference('#32');
    // A restart before discovery reached the id: the durable row is back, the facts are not.
    internals(agent).onChainContextGraphFacts.delete('32');
    expect(agent.lookupContextGraphOnChainIdReference('#32')).toEqual({
      kind: 'held',
      onChainId: '32',
      contextGraphId: NAME_HASH,
      nameHash: NAME_HASH,
    });

    await agent.adoptVerifiedContextGraphCleartext({ nameHash: NAME_HASH, onChainId: '32' }, CLEARTEXT, 'local');
    internals(agent).onChainContextGraphFacts.delete('32');
    expect(agent.lookupContextGraphOnChainIdReference('#32')).toMatchObject({ kind: 'held', contextGraphId: CLEARTEXT });
    // A row that is bound elsewhere, or not bound at all, is not taken for it.
    expect(agent.lookupContextGraphOnChainIdReference('#31')).toEqual({ kind: 'not-held', onChainId: '31' });
  });

  it('reports a failure while resolving as unavailable instead of throwing', async () => {
    const agent = await startAgent(await chainWithGraph32());
    await agent.discoverContextGraphsFromStorage();
    // The staged row is gone, so resolving stages it again, and that fails.
    agent.deleteContextGraphSubscription(NAME_HASH);
    internals(agent).wireIdToLocalCgId.delete(NAME_HASH);
    vi.spyOn(agent, 'stageOnChainContextGraphBindingFromNameHash').mockImplementation(() => {
      throw new Error('store is closed');
    });
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({
      kind: 'unavailable',
      onChainId: '32',
      detail: 'store is closed',
    });
  });

  it('reads an id discovery has not reached yet and stages its row the way discovery does', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain);
    const read = vi.spyOn(chain, 'readContextGraphStorageRange');
    expect(agent.getSubscribedContextGraphs().has(NAME_HASH)).toBe(false);

    await expect(agent.resolveContextGraphOnChainIdReference('32')).resolves.toMatchObject({
      kind: 'resolved',
      contextGraphId: NAME_HASH,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toMatchObject({ fromId: 32n, maxIds: 1 });
    // The row a discovery pass would have staged: hash-keyed, bound, not subscribed.
    expect(agent.getSubscribedContextGraphs().get(NAME_HASH)).toMatchObject({
      subscribed: false,
      onChainId: '32',
      onChainHash: NAME_HASH,
    });
    expect(agent.describeContextGraphIdentity(NAME_HASH)).toMatchObject({ state: 'name-hash-only', onChainId: '32' });
    expect(rowIds(agent)).not.toContain('32');

    // Subscribing what it resolved to is the #2744 name-hash path.
    agent.subscribeToContextGraph(NAME_HASH, { syncMode: 'on-demand' });
    expect(agent.contextGraphNameTargetFor(NAME_HASH)).toEqual({ nameHash: NAME_HASH, onChainId: '32' });
    // The facts are kept, so a second resolution reads nothing.
    await agent.resolveContextGraphOnChainIdReference('#32');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('resolves to the verified cleartext id once the node knows it', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain);
    await agent.discoverContextGraphsFromStorage();
    await expect(
      agent.adoptVerifiedContextGraphCleartext({ nameHash: NAME_HASH, onChainId: '32' }, CLEARTEXT, 'local'),
    ).resolves.toBe(true);

    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({
      kind: 'resolved',
      onChainId: '32',
      nameHash: NAME_HASH,
      contextGraphId: CLEARTEXT,
      private: false,
    });
    expect(agent.lookupContextGraphOnChainIdReference('#32')).toEqual({
      kind: 'held',
      onChainId: '32',
      contextGraphId: CLEARTEXT,
      nameHash: NAME_HASH,
    });
  });

  it('says an id does not exist, and what the latest id is', async () => {
    const agent = await startAgent(await chainWithGraph32());
    await expect(agent.resolveContextGraphOnChainIdReference('#99')).resolves.toEqual({
      kind: 'not-found',
      onChainId: '99',
      latestId: '32',
    });
    expect(internals(agent).onChainContextGraphFacts.has('99')).toBe(false);
  });

  it('reads a graph the live event tail reported, since the event does not say whether it is still active', async () => {
    const observed = {
      contextGraphId: '32',
      owner: MOCK_DEFAULT_SIGNER,
      accessPolicy: 0,
      publishPolicy: 0,
      nameHash: NAME_HASH,
      observedAtBlock: 5,
    };
    const chain = await chainWithGraph32({ active: false });
    const agent = await startAgent(chain);
    agent.applyOnChainContextGraphObservation(observed, { source: 'event' });
    const read = vi.spyOn(chain, 'readContextGraphStorageRange');
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({ kind: 'inactive', onChainId: '32' });
    expect(read).toHaveBeenCalledTimes(1);

    // If that read fails, the event's facts still name the graph.
    const freshChain = await chainWithGraph32();
    const fresh = await startAgent(freshChain);
    fresh.applyOnChainContextGraphObservation(observed, { source: 'event' });
    vi.spyOn(freshChain, 'readContextGraphStorageRange').mockRejectedValue(new Error('RPC timed out'));
    await expect(fresh.resolveContextGraphOnChainIdReference('32')).resolves.toMatchObject({
      kind: 'resolved',
      contextGraphId: NAME_HASH,
    });
  });

  it('refuses a deactivated graph, whether discovered or read on demand', async () => {
    const chain = await chainWithGraph32({ active: false });
    const agent = await startAgent(chain);
    await expect(agent.resolveContextGraphOnChainIdReference('32')).resolves.toEqual({ kind: 'inactive', onChainId: '32' });
    await agent.discoverContextGraphsFromStorage();
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({ kind: 'inactive', onChainId: '32' });
  });

  it('refuses a graph whose creator opted out of the name hash', async () => {
    const agent = await startAgent(await chainWithGraph32({ nameHash: null }));
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({ kind: 'no-name-hash', onChainId: '32' });
    expect(rowIds(agent)).not.toContain('32');
  });

  it('resolves a private graph like any other and leaves the refusal to the one private rule', async () => {
    const chain = await chainWithGraph32({ accessPolicy: 1 });
    const agent = await startAgent(chain);
    const hashOnly = await agent.resolveContextGraphOnChainIdReference('#32');
    expect(hashOnly).toEqual({
      kind: 'resolved',
      onChainId: '32',
      nameHash: NAME_HASH,
      contextGraphId: NAME_HASH,
      private: true,
    });
    // Holding only the name hash, nobody can subscribe it by number.
    for (const admission of [undefined, 'allowed', 'denied', 'unavailable'] as const) {
      expect(refusesPrivateContextGraphByOnChainId(hashOnly as ResolvedContextGraphOnChainId, admission)).toBe(true);
    }

    // A member (or the curator) holds the cleartext row; its caller's read
    // authority decides.
    await agent.adoptVerifiedContextGraphCleartext({ nameHash: NAME_HASH, onChainId: '32' }, CLEARTEXT, 'local');
    const member = await agent.resolveContextGraphOnChainIdReference('#32') as ResolvedContextGraphOnChainId;
    expect(member).toMatchObject({ kind: 'resolved', contextGraphId: CLEARTEXT, private: true });
    expect(refusesPrivateContextGraphByOnChainId(member, 'denied')).toBe(true);
    expect(refusesPrivateContextGraphByOnChainId(member, 'allowed')).toBe(false);
    expect(refusesPrivateContextGraphByOnChainId(member)).toBe(false);
  });

  it('keeps a literal subscription key "32" that the chain does not prove wrong, unless #32 is written', async () => {
    const agent = await startAgent(await chainWithGraph32());
    // A graph literally named "32", unbound: nothing proves it is not one.
    agent.subscribeToContextGraph('32', { syncMode: 'on-demand' });

    await expect(agent.resolveContextGraphOnChainIdReference('32')).resolves.toEqual({ kind: 'as-given' });
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toMatchObject({
      kind: 'resolved',
      contextGraphId: NAME_HASH,
    });
    expect(agent.getSubscribedContextGraphs().get('32')).toMatchObject({ subscribed: true });
  });

  it('keeps a literal key when the chain cannot be read, and fails closed without one', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain);
    vi.spyOn(chain, 'readContextGraphStorageRange').mockRejectedValue(new Error('RPC timed out'));
    await expect(agent.resolveContextGraphOnChainIdReference('32')).resolves.toEqual({
      kind: 'unavailable',
      onChainId: '32',
      detail: 'RPC timed out',
    });
    subscribeTheNumber(agent);
    await expect(agent.resolveContextGraphOnChainIdReference('32')).resolves.toEqual({ kind: 'as-given' });
  });

  it('treats an id below the latest one that reads as missing as a lagging backend, not as nonexistent', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain);
    vi.spyOn(chain, 'readContextGraphStorageRange').mockResolvedValue({
      storageAddress: `0x${'c6'.repeat(20)}`,
      anchorBlockNumber: 7,
      anchorBlockHash: `0x${'00'.repeat(32)}`,
      latestId: 40n,
      entries: [],
      nextId: 32n,
    });
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({
      kind: 'unavailable',
      onChainId: '32',
      detail: 'id 32 is not readable yet at block 7',
    });
  });

  it('cannot resolve on-chain ids without a ContextGraphStorage reader', async () => {
    const chain = await chainWithGraph32();
    Object.defineProperty(chain, 'readContextGraphStorageRange', { value: undefined });
    const withoutReader = await startAgent(chain);
    await expect(withoutReader.resolveContextGraphOnChainIdReference('32'))
      .resolves.toEqual({ kind: 'unsupported', onChainId: '32' });

    // With no chain at all, a bare number is only a name.
    const chainless = await startAgent(undefined);
    await expect(chainless.resolveContextGraphOnChainIdReference('32')).resolves.toEqual({ kind: 'as-given' });
    await expect(chainless.resolveContextGraphOnChainIdReference('#32'))
      .resolves.toEqual({ kind: 'unsupported', onChainId: '32' });
    expect(chainless.lookupContextGraphOnChainIdReference('32')).toEqual({ kind: 'as-given' });
    expect(chainless.lookupContextGraphOnChainIdReference('#32')).toEqual({ kind: 'not-held', onChainId: '32' });
  });

  it('stages the row again when it was pruned, and refuses a name hash another on-chain id holds', async () => {
    const agent = await startAgent(await chainWithGraph32());
    await agent.discoverContextGraphsFromStorage();
    agent.deleteContextGraphSubscription(NAME_HASH);
    internals(agent).wireIdToLocalCgId.delete(NAME_HASH);

    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toMatchObject({
      kind: 'resolved',
      contextGraphId: NAME_HASH,
    });
    expect(agent.getSubscribedContextGraphs().get(NAME_HASH)).toMatchObject({ onChainId: '32' });

    // The same name hash now bound to on-chain #31 on this node.
    const row = agent.getSubscribedContextGraphs().get(NAME_HASH)!;
    internals(agent).subscribedContextGraphs.set(NAME_HASH, { ...row, onChainId: '31' });
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toMatchObject({
      kind: 'unavailable',
      detail: expect.stringContaining('bound to another on-chain id'),
    });
  });
});

/** Hold the chain's ContextGraphStorage reads until `release()`. */
function gateStorageReads(chain: MockChainAdapter) {
  const realRead = chain.readContextGraphStorageRange.bind(chain);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = vi.spyOn(chain, 'readContextGraphStorageRange')
    .mockImplementation(async (options) => {
      await gate;
      return realRead(options);
    });
  return { read, release };
}

describe('waiting for a ContextGraphStorage read', () => {
  const budgets = { request: 150, cold: 10_000 };

  it('waits the request budget, not the cold one, and the read finishes detached for the next call', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain, { budgets });
    const { request, cold } = {
      request: agent.chainAuthorityReadBudgets.requestTimeoutMs,
      cold: agent.chainAuthorityReadBudgets.coldResolutionTimeoutMs,
    };
    expect(cold).toBeGreaterThan(request * 10);
    const { read, release } = gateStorageReads(chain);

    const startedAt = Date.now();
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({
      kind: 'unavailable',
      onChainId: '32',
      detail: `no answer within ${request} ms; the read continues, so a retry may find it`,
    });
    expect(Date.now() - startedAt).toBeLessThan(cold / 2);
    expect(internals(agent).onChainContextGraphFacts.has('32')).toBe(false);

    // The read was not abandoned: once the chain answers, the graph is recorded.
    release();
    await vi.waitFor(() => expect(internals(agent).onChainContextGraphFacts.has('32')).toBe(true));
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toMatchObject({
      kind: 'resolved',
      contextGraphId: NAME_HASH,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('shares one read between concurrent callers', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain, { budgets: { request: 5_000, cold: 10_000 } });
    const { read, release } = gateStorageReads(chain);
    const waiting = Promise.all([
      agent.resolveContextGraphOnChainIdReference('#32'),
      agent.resolveContextGraphOnChainIdReference('32'),
    ]);
    setTimeout(release, 50);
    const answers = await waiting;
    for (const answer of answers) expect(answer).toMatchObject({ kind: 'resolved', contextGraphId: NAME_HASH });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('waits the cold budget when asked to, as start-up does', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain, { budgets });
    const { release } = gateStorageReads(chain);
    setTimeout(release, agent.chainAuthorityReadBudgets.requestTimeoutMs * 3);
    await expect(agent.resolveContextGraphOnChainIdReference('#32', { wait: 'background' })).resolves.toMatchObject({
      kind: 'resolved',
      contextGraphId: NAME_HASH,
    });
  });

  it('stops waiting when the caller\'s signal aborts', async () => {
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain, { budgets: { request: 10_000, cold: 20_000 } });
    const { release } = gateStorageReads(chain);
    const caller = new AbortController();
    const answer = agent.resolveContextGraphOnChainIdReference('#32', { signal: caller.signal });
    caller.abort(new Error('client disconnected'));
    await expect(answer).resolves.toEqual({ kind: 'unavailable', onChainId: '32', detail: 'client disconnected' });
    release();
    await vi.waitFor(() => expect(internals(agent).onChainContextGraphFacts.has('32')).toBe(true));
  });
});

describe('a subscription keyed by the number, left by the pre-fix subscribe path', () => {
  it('is retired, durably, and its member intent is reported for the resolved graph', async () => {
    const { store, records } = memorySubscriptionStore();
    const chain = await chainWithGraph32();
    const agent = await startAgent(chain, { store, syncContextGraphs: ['32'] });
    subscribeTheNumber(agent);
    await vi.waitFor(() => expect(records.get('32')).toMatchObject({ subscribed: true, onChainId: '32' }));
    expect(internals(agent).wireIdToLocalCgId.get(NUMBER_HASH)).toBe('32');

    await expect(agent.resolveContextGraphOnChainIdReference('32')).resolves.toEqual({
      kind: 'resolved',
      onChainId: '32',
      nameHash: NAME_HASH,
      contextGraphId: NAME_HASH,
      private: false,
      retiredNumericSubscription: { contextGraphId: '32', subscribed: true, syncMode: 'always-on' },
    });
    expect(rowIds(agent)).not.toContain('32');
    expect(internals(agent).wireIdToLocalCgId.has(NUMBER_HASH)).toBe(false);
    expect(internals(agent).config.syncContextGraphs ?? []).not.toContain('32');
    await vi.waitFor(() => expect(records.has('32')).toBe(false));

    // Idempotent: nothing left to retire.
    await expect(agent.resolveContextGraphOnChainIdReference('32')).resolves.not.toHaveProperty('retiredNumericSubscription');
  });

  it('is retired even when the graph turned out not to be subscribable, but a Core-hosted row is left alone', async () => {
    const agent = await startAgent(await chainWithGraph32({ active: false }));
    subscribeTheNumber(agent, 'on-demand');
    await expect(agent.resolveContextGraphOnChainIdReference('#32')).resolves.toEqual({ kind: 'inactive', onChainId: '32' });
    expect(rowIds(agent)).not.toContain('32');

    const hosting = await startAgent(await chainWithGraph32());
    subscribeTheNumber(hosting);
    const row = hosting.getSubscribedContextGraphs().get('32')!;
    internals(hosting).subscribedContextGraphs.set('32', { ...row, coreHosted: true });
    await expect(hosting.resolveContextGraphOnChainIdReference('32')).resolves.toEqual({ kind: 'as-given' });
    expect(hosting.isNumericContextGraphAlias('32', { ...row, coreHosted: true }, NAME_HASH)).toBe(false);
  });

  it('is the only way numeric input reached the RFC-64 "invalid identity" rejection', async () => {
    const agent = await startAgent(await chainWithGraph32());
    await agent.discoverContextGraphsFromStorage();
    const signal = new AbortController().signal;

    // Before: the row keyed "32" checks slot 32's finalized evidence against
    // keccak256("32") and is rejected, on every scheduled pass.
    subscribeTheNumber(agent);
    await expect(agent.reconcileRfc64CatalogResponsibilityCoreV1('32', signal, {
      authorityRequest: finalizedEvidenceFor32(),
    })).rejects.toThrow('RFC-64 scheduled responsibility evidence has invalid identity');

    // After: the number resolves to the hash-keyed row, whose identity is the
    // slot's committed name hash, and no row keyed "32" is left to check.
    const resolution = await agent.resolveContextGraphOnChainIdReference('32');
    expect(resolution).toMatchObject({ kind: 'resolved', contextGraphId: NAME_HASH });
    agent.subscribeToContextGraph(NAME_HASH, { syncMode: 'always-on' });
    expect(rowIds(agent)).not.toContain('32');
    const outcome = await agent.reconcileRfc64CatalogResponsibilityCoreV1(NAME_HASH, signal, {
      authorityRequest: finalizedEvidenceFor32(),
    }).then(() => 'accepted', (error: unknown) => String(error));
    expect(outcome).not.toMatch(/invalid identity/);
    await expect(agent.reconcileRfc64CatalogResponsibilityCoreV1('32', signal, {
      authorityRequest: finalizedEvidenceFor32(),
    })).resolves.toBeDefined();
  });
});
