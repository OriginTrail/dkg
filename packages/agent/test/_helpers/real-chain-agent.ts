/**
 * Real-chain agent fixture: what every agent E2E that runs real `DKGAgent`s over
 * real libp2p on the shared Hardhat chain needs before its scenario starts.
 *
 * It owns the mechanics that were being copied from suite to suite:
 *  - the indexed EVM adapter (a daemon wires the finalized Context Graph authority
 *    index into its chain adapter; the plain test adapter does not, and without it
 *    an agent resolves authority through the legacy path);
 *  - the daemon-equivalent agent configuration (KA-number allocator, snapshot
 *    storage, edge role, the chain config for one operational key);
 *  - starting agents and stopping every agent a test started, in the order the
 *    suite's cleanup hook wants;
 *  - connecting two agents and waiting for identify, and the polling helper.
 *
 * What it deliberately does NOT own, so each suite keeps the parts that differ:
 *  - the Hardhat snapshot (`takeSnapshot` / `revertSnapshot`) and any funding;
 *  - WHEN agents are stopped (each suite registers its own `afterEach` /
 *    `afterAll` and calls `stopAll`), and `vi.restoreAllMocks()`;
 *  - the scenario: graphs, malicious peers, restarts, persistence, counters.
 *
 * The pieces compose instead of forming one harness: a suite that needs to build
 * its adapter itself (to wrap it before the agent exists), give an agent a data
 * directory or a subscription store, or start agents later uses `create`; the
 * common case is `startNode`.
 */
import { expect } from 'vitest';
import type { DKGAgentConfig } from '../../src/dkg-agent-types.js';
import { DKGAgent } from '../../src/index.js';
import type { KaNumberAllocator } from '../../src/allocator.js';
import { TEST_SNAPSHOT_CONFIG } from '../../../../scripts/testing/snapshot-storage.js';
import { getSharedContext } from '../../../chain/test/evm-test-context.js';
import { makeAdapterConfig } from '../../../chain/test/hardhat-harness.js';
import { MemoryAuthorityIndexStore } from '../../../chain/test/helpers/context-graph-authority-index.js';
import { EVMChainAdapter } from '../../../chain/src/evm-adapter.js';
import { makeTestKaNumberAllocator } from './ka-allocator.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `fn` until `pred` accepts its value or `timeoutMs` passes, and return the
 * last value either way (the caller asserts on it). The timeout and the step are
 * required: suites poll at different paces, and a shared default would quietly
 * change one of them.
 */
export async function pollUntil<T>(
  fn: () => Promise<T> | T,
  pred: (value: T) => boolean,
  timeoutMs: number,
  stepMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

/**
 * A daemon wires the finalized Context Graph authority index into its chain
 * adapter; the plain test adapter does not. This is the adapter with an
 * in-memory authority-index store, for one operational key.
 */
export function createIndexedEVMAdapter(privateKey: string): EVMChainAdapter {
  const { rpcUrl, hubAddress } = getSharedContext();
  const adapter = new EVMChainAdapter({
    ...makeAdapterConfig(rpcUrl, hubAddress, privateKey),
    localContextGraphAuthorityIndexStore: new MemoryAuthorityIndexStore(),
  });
  // What the store is for: an adapter without it resolves authority through the
  // legacy path, and a scenario that needs the index would then test something else.
  expect(adapter.contextGraphAuthorityIndexRevisionReader, 'the adapter reads the finalized authority index').toBeDefined();
  return adapter;
}

/** The agent's `chainConfig` for the shared Hardhat chain and one operational key. */
export function realChainConfig(operationalKey: string) {
  const { rpcUrl, hubAddress } = getSharedContext();
  return {
    rpcUrl,
    hubAddress,
    operationalKeys: [operationalKey],
    chainId: 'evm:31337',
  };
}

export interface RealChainAgentOptions {
  readonly name: string;
  /** The operational key: it fixes the agent's default agent address. */
  readonly operationalKey: string;
  /** Default: an indexed adapter for `operationalKey` (built here, when the agent is created). */
  readonly chainAdapter?: EVMChainAdapter;
  /** Default: a fresh in-memory allocator. Pass one to make a restarted agent continue a sequence. */
  readonly kaNumberAllocator?: KaNumberAllocator;
  /** Left to the agent's default when omitted. */
  readonly listenHost?: string;
  /** Left to the agent's default when omitted. */
  readonly dataDir?: string;
  /** Left unset when omitted (the agent then keeps its subscriptions in memory only). */
  readonly contextGraphSubscriptionStore?: DKGAgentConfig['contextGraphSubscriptionStore'];
}

/** What `startNode` returns: the started agent, its chain adapter and its default agent address. */
export interface RealChainNode {
  readonly agent: DKGAgent;
  readonly chain: EVMChainAdapter;
  /** Lower-case default agent address. */
  readonly address: string;
}

/**
 * The agents one suite (or one test) started. Every agent is tracked as soon as
 * it exists, before it is started, so a failing start is still cleaned up.
 */
export class RealChainAgents {
  private readonly agents: DKGAgent[] = [];

  /** Create (not start) an edge agent on the shared chain, and track it. */
  async create(options: RealChainAgentOptions): Promise<DKGAgent> {
    const chainAdapter = options.chainAdapter ?? createIndexedEVMAdapter(options.operationalKey);
    const agent = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: options.kaNumberAllocator ?? makeTestKaNumberAllocator(),
      name: options.name,
      ...(options.listenHost === undefined ? {} : { listenHost: options.listenHost }),
      listenPort: 0,
      skills: [],
      chainAdapter,
      nodeRole: 'edge',
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.contextGraphSubscriptionStore === undefined
        ? {}
        : { contextGraphSubscriptionStore: options.contextGraphSubscriptionStore }),
      chainConfig: realChainConfig(options.operationalKey),
    });
    this.agents.push(agent);
    return agent;
  }

  /** The common case: an indexed adapter, an agent listening on 127.0.0.1, started. */
  async startNode(name: string, operationalKey: string): Promise<RealChainNode> {
    const chain = createIndexedEVMAdapter(operationalKey);
    const agent = await this.create({ name, operationalKey, chainAdapter: chain, listenHost: '127.0.0.1' });
    await agent.start();
    const address = agent.getDefaultAgentAddress()!.toLowerCase();
    return { agent, chain, address };
  }

  /**
   * Stop every tracked agent and forget them. Newest first by default; `'oldest-first'`
   * keeps the order of a suite that stopped them in creation order. An agent that is
   * already stopped is not an error.
   */
  async stopAll(order: 'newest-first' | 'oldest-first' = 'newest-first'): Promise<void> {
    const batch = this.agents.splice(0);
    if (order === 'newest-first') batch.reverse();
    for (const agent of batch) {
      try { await agent.stop(); } catch { /* already stopped */ }
    }
  }
}

/** A direct TCP address of `agent`, the one a peer dials (never a relay circuit). */
export function dialableAddress(agent: DKGAgent): string {
  return agent.multiaddrs.find((address) => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!;
}

/**
 * Dial `to` from `from`, and wait until `from` has the peer's identify record
 * (its protocol list): before that, the requester cannot see which protocols the
 * peer speaks.
 */
export async function connectWithIdentify(from: DKGAgent, to: DKGAgent): Promise<void> {
  await from.connectTo(dialableAddress(to));
  const advertised = await pollUntil(
    () => from.node.libp2p.peerStore.get(to.node.libp2p.peerId)
      .then((peer) => peer.protocols.length)
      .catch(() => 0),
    (count) => count > 0,
    15_000,
    100,
  );
  expect(advertised, 'identify completed').toBeGreaterThan(0);
}
