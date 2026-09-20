// SPDX-License-Identifier: Apache-2.0

/**
 * ONE log per node, and the adapter that owns it.
 *
 * The rule the whole design rests on is that exactly one adapter in a process
 * builds a tick. These pin both halves: an adapter given no store builds
 * nothing (so the per-wallet publisher adapters can never become a second
 * scanner), and the one given a store attaches its binding before it starts.
 */

import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB_ADDRESS = '0x0000000000000000000000000000000000000001';

function config(store?: MemoryChainEventLogStore): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB_ADDRESS,
    chainId: 'evm:31337',
    staticNetwork: false,
    allowNoAdminSigner: true,
    ...(store === undefined ? {} : { chainEventLogStore: store }),
  } as EVMAdapterConfig;
}

/** Stand in for the Hub the adapter would have resolved through `initContracts`. */
function stubHub(adapter: EVMChainAdapter): void {
  const internals = adapter as unknown as {
    contracts: Record<string, unknown>;
    readTipProvider: unknown;
    resolveContractDeployBlockNumber: unknown;
  };
  internals.contracts.hub = {
    interface: new ethers.Interface(loadAbi('Hub')),
    getAddress: async () => ethers.getAddress(HUB_ADDRESS),
  };
  internals.contracts.contextGraphStorage = undefined;
  internals.contracts.knowledgeAssetStorage = undefined;
  internals.resolveContractDeployBlockNumber = async () => 1;
  internals.readTipProvider = async (
    _label: string,
    read: (provider: unknown) => Promise<unknown>,
  ) => read({
    getBlock: async (tag: string | number) => ({
      number: typeof tag === 'number' ? tag : 500,
      hash: `0x${(typeof tag === 'number' ? tag : 500).toString(16).padStart(64, '0')}`,
      timestamp: 1_700_000_000,
    }),
    getLogs: async () => [],
  });
}

function startChainIndex(adapter: EVMChainAdapter): void {
  (adapter as unknown as { startChainIndexRuntime(): void }).startChainIndexRuntime();
}

describe('EVMChainAdapter chain index wiring', () => {
  it('builds NOTHING for an adapter the composition root gave no store', async () => {
    const adapter = new EVMChainAdapter(config());
    stubHub(adapter);
    startChainIndex(adapter);
    // Await the detached start itself, not a turn of the loop: a fixed number
    // of microtasks would let this pass simply by not having run yet, which is
    // the vacuous version of exactly this assertion.
    await (adapter as unknown as { chainIndexStart?: Promise<void> }).chainIndexStart;

    // This is the "never two scanners" guarantee, stated where it is enforced.
    expect(adapter.chainEventLog).toBeUndefined();
    expect((adapter as unknown as { chainIndexRuntime: unknown }).chainIndexRuntime)
      .toBeUndefined();
    adapter.destroy();
  });

  it('attaches the binding for the one adapter that owns the store', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });

    const binding = adapter.chainEventLog!;
    expect(typeof binding.readHubRotationWindow).toBe('function');
    // No ContextGraphStorage in this Hub, so no address is claimed — a reader
    // with none falls back rather than proving a range against a guess.
    expect(binding.contextGraphStorageAddress).toBeUndefined();
    adapter.destroy();
  });

  it('starts at most ONE runtime however often initContracts runs again', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    const internals = adapter as unknown as { chainIndexStart?: Promise<void> };
    stubHub(adapter);
    startChainIndex(adapter);
    // A Hub rotation re-runs `initContracts`; a second tick on the same cursor
    // would only lose the CAS and repeat the first one's requests. The
    // single-flight is asserted on the PROMISE, not on the field it assigns:
    // a later start overwrites that field asynchronously, so comparing it
    // would pass simply because the second attempt had not landed yet.
    const started = internals.chainIndexStart;
    expect(started).toBeDefined();
    startChainIndex(adapter);
    startChainIndex(adapter);
    expect(internals.chainIndexStart).toBe(started);

    await started;
    expect(adapter.chainEventLog).toBeDefined();
    adapter.destroy();
  });

  it('takes its interval from chain.indexTickMs and refuses an invalid one', async () => {
    const store = new MemoryChainEventLogStore();
    const rejected = new EVMChainAdapter({ ...config(store), indexTickMs: 0 });
    stubHub(rejected);
    startChainIndex(rejected);
    await (rejected as unknown as { chainIndexStart?: Promise<void> }).chainIndexStart;

    // An operator who mis-set T must not silently get a tick on some other
    // cadence: every staleness bound on this node is derived from that number.
    expect(rejected.chainEventLog).toBeUndefined();
    rejected.destroy();

    const accepted = new EVMChainAdapter({ ...config(store), indexTickMs: 12_000 });
    stubHub(accepted);
    startChainIndex(accepted);
    await (accepted as unknown as { chainIndexStart?: Promise<void> }).chainIndexStart;
    expect(accepted.chainEventLog).toBeDefined();
    accepted.destroy();
  });

  it('clears the binding on destroy so nothing reads a stopped log', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });

    adapter.destroy();
    expect(adapter.chainEventLog).toBeUndefined();
  });
});
