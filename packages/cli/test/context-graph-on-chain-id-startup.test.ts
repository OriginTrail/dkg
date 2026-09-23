/**
 * Configured on-chain Context Graph ids at daemon start, on a real agent over
 * a mock chain shaped like Gnosis mainnet on 2026-09-23 (Context Graph #32:
 * public, created long before this node booted).
 *
 * Before this fix, `dkg subscribe 32 --save` wrote "32" to config.contextGraphs
 * and kept a durable subscription keyed "32"; every start subscribed the
 * number again, and it synced nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKGAgent,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionStore,
} from '@origintrail-official/dkg-agent';
import { bootstrapConfiguredContextGraphs } from '../src/daemon/lifecycle.js';

const CLEARTEXT = 'gnosis-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const SHORT_HASH = `${NAME_HASH.slice(0, 10)}…${NAME_HASH.slice(-4)}`;
const BEYOND_LIVE_LOOKBACK_BLOCKS = 600;

const agents: DKGAgent[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (agents.length > 0) await agents.pop()!.stop().catch(() => {});
});

async function gnosisShapedChain(): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  for (let id = 1; id < 32; id++) {
    await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(`other-graph-${id}`)),
    } as never);
  }
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 0, nameHash: NAME_HASH } as never);
  for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();
  return chain;
}

function memorySubscriptionStore() {
  const records = new Map<string, ContextGraphSubscriptionRecord>();
  const store: ContextGraphSubscriptionStore = {
    loadAll: async () => [...records.values()].map((row) => ({ ...row })),
    save: async (record) => { records.set(record.id, { ...record }); },
    delete: async (contextGraphId) => { records.delete(contextGraphId); },
  };
  return { store, records };
}

/** One daemon start: the agent, then the configured-graph bootstrap. */
async function start(
  chain: MockChainAdapter,
  store: ContextGraphSubscriptionStore,
  configured: string[],
): Promise<{ agent: DKGAgent; log: string[] }> {
  const agent = await DKGAgent.create({
    name: 'GnosisEdge',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionStore: store,
    syncContextGraphs: configured,
  });
  agents.push(agent);
  await agent.start();
  await agent.awaitInitialChainPoll();
  const log: string[] = [];
  await bootstrapConfiguredContextGraphs({
    agent,
    configuredContextGraphIds: configured,
    networkDefaultContextGraphIds: [],
    log: (line) => log.push(line),
  });
  return { agent, log };
}

async function stop(agent: DKGAgent): Promise<void> {
  await agent.stop();
  agents.splice(agents.indexOf(agent), 1);
}

/** Subscribed user graphs (the system graphs are always subscribed). */
function subscribedIds(agent: DKGAgent): string[] {
  return [...agent.getSubscribedContextGraphs()]
    .filter(([id, row]) => row.subscribed === true && id !== 'agents' && id !== 'ontology')
    .map(([id]) => id)
    .sort();
}

describe('configured on-chain Context Graph ids at start', () => {
  it('subscribes the graph a configured "32" names on every start, and never the number', async () => {
    const chain = await gnosisShapedChain();
    const { store, records } = memorySubscriptionStore();

    for (let restart = 0; restart < 2; restart += 1) {
      const { agent, log } = await start(chain, store, ['32']);
      expect(subscribedIds(agent)).toEqual([NAME_HASH]);
      expect(agent.getSubscribedContextGraphs().get(NAME_HASH)).toMatchObject({ syncMode: 'always-on' });
      expect(log).toContain(
        `Configured context graph "32": On-chain Context Graph #32 is Context Graph ${SHORT_HASH} (its on-chain name hash). `
        + `Subscribing "${NAME_HASH}"; you can replace "32" in config.contextGraphs with it.`,
      );
      await vi.waitFor(() => expect(records.get(NAME_HASH)).toMatchObject({ subscribed: true }));
      expect(records.has('32')).toBe(false);
      await stop(agent);
    }

    // What `dkg subscribe 32 --save` now writes restarts into the same graph.
    const { agent } = await start(chain, store, [NAME_HASH]);
    expect(subscribedIds(agent)).toEqual([NAME_HASH]);
  }, 120_000);

  it('retires the durable subscription an earlier `dkg subscribe 32 --save` left, once', async () => {
    const chain = await gnosisShapedChain();
    const { store, records } = memorySubscriptionStore();
    // 10.0.18: the subscribe route kept "32", bound to on-chain 32, always-on.
    const legacy = await DKGAgent.create({
      name: 'GnosisEdge',
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: chain,
      rfc64CatalogActivation: { enabled: false },
      contextGraphSubscriptionStore: store,
    });
    agents.push(legacy);
    await legacy.start();
    legacy.subscribeToContextGraph('32', { syncMode: 'always-on', onChainId: '32' });
    await vi.waitFor(() => expect(records.get('32')).toMatchObject({ subscribed: true, onChainId: '32' }));
    await stop(legacy);

    const first = await start(chain, store, ['32']);
    expect(subscribedIds(first.agent)).toEqual([NAME_HASH]);
    expect(first.log.join('\n')).toContain('Retired the subscription keyed "32", which could never sync.');
    await vi.waitFor(() => expect(records.has('32')).toBe(false));
    await stop(first.agent);

    const second = await start(chain, store, ['32']);
    expect(subscribedIds(second.agent)).toEqual([NAME_HASH]);
    expect(second.log.join('\n')).not.toContain('Retired');
  }, 120_000);

  it('moves a numeric subscription made through the API, with no config entry, to its graph', async () => {
    const chain = await gnosisShapedChain();
    const { store, records } = memorySubscriptionStore();
    const legacy = await DKGAgent.create({
      name: 'GnosisEdge',
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: chain,
      rfc64CatalogActivation: { enabled: false },
      contextGraphSubscriptionStore: store,
    });
    agents.push(legacy);
    await legacy.start();
    legacy.subscribeToContextGraph('32', { syncMode: 'always-on', onChainId: '32' });
    await vi.waitFor(() => expect(records.has('32')).toBe(true));
    await stop(legacy);

    const { agent, log } = await start(chain, store, []);
    expect(subscribedIds(agent)).toEqual([NAME_HASH]);
    expect(log.join('\n')).toContain(`Context graph subscription "32": On-chain Context Graph #32 is Context Graph ${SHORT_HASH}`);
    await vi.waitFor(() => expect(records.has('32')).toBe(false));
  }, 120_000);

  it('logs and skips a configured id that names nothing subscribable, and never subscribes the number', async () => {
    const chain = await gnosisShapedChain();
    const { store } = memorySubscriptionStore();
    const missing = await start(chain, store, ['#99', 'acme-configured']);
    expect(missing.log).toContain(
      'Configured context graph "#99" is not subscribed: Context Graph #99 does not exist on chain: '
      + 'the latest Context Graph id is 32. A graph created moments ago appears once its creation block is final.',
    );
    expect(subscribedIds(missing.agent)).toEqual(['acme-configured']);
    await stop(missing.agent);

    vi.spyOn(chain, 'readContextGraphStorageRange').mockRejectedValue(new Error('RPC timed out'));
    const unreadable = await start(chain, memorySubscriptionStore().store, ['32']);
    expect(unreadable.log).toContain(
      'Configured context graph "32" is not subscribed: Could not read Context Graph #32 from ContextGraphStorage '
      + '(RPC timed out); retry once the chain RPC responds.',
    );
    expect(subscribedIds(unreadable.agent)).toEqual([]);
  }, 120_000);
});
