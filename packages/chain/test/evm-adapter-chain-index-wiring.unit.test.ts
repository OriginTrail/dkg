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
const RETIRED_CG_STORAGE = '0x00000000000000000000000000000000000000aa';
const ROTATED_CG_STORAGE = '0x00000000000000000000000000000000000000bb';

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

function chainIndexOwner(adapter: EVMChainAdapter): Readonly<{
  starting?: Promise<void>;
  runtime?: unknown;
}> {
  return (adapter as unknown as {
    chainIndexOwner: Readonly<{ starting?: Promise<void>; runtime?: unknown }>;
  }).chainIndexOwner;
}

/** `ContextGraphStorage` as `initContracts` would have resolved it. */
function stubContextGraphStorage(adapter: EVMChainAdapter, address: string): void {
  (adapter as unknown as { contracts: Record<string, unknown> })
    .contracts.contextGraphStorage = {
      interface: new ethers.Interface(loadAbi('ContextGraphStorage')),
      getAddress: async () => ethers.getAddress(address),
    };
}

/** What the Hub rotation listener calls when it sees a name move. */
function dispatchHubRotation(adapter: EVMChainAdapter, name: string): void {
  (adapter as unknown as { applyHubRotationEventName(name: string): void })
    .applyHubRotationEventName(name);
}

describe('EVMChainAdapter chain index wiring', () => {
  it('builds NOTHING for an adapter the composition root gave no store', async () => {
    const adapter = new EVMChainAdapter(config());
    stubHub(adapter);
    startChainIndex(adapter);
    // Await the detached start itself, not a turn of the loop: a fixed number
    // of microtasks would let this pass simply by not having run yet, which is
    // the vacuous version of exactly this assertion.
    await chainIndexOwner(adapter).starting;

    // This is the "never two scanners" guarantee, stated where it is enforced.
    expect(adapter.chainEventLog).toBeUndefined();
    expect(chainIndexOwner(adapter).runtime).toBeUndefined();
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
    stubHub(adapter);
    startChainIndex(adapter);
    // A Hub rotation re-runs `initContracts`; a second tick on the same cursor
    // would only lose the CAS and repeat the first one's requests. The
    // single-flight is asserted on the PROMISE, not on the field it assigns:
    // a later start overwrites that field asynchronously, so comparing it
    // would pass simply because the second attempt had not landed yet.
    const started = chainIndexOwner(adapter).starting;
    expect(started).toBeDefined();
    startChainIndex(adapter);
    startChainIndex(adapter);
    expect(chainIndexOwner(adapter).starting).toBe(started);

    await started;
    expect(adapter.chainEventLog).toBeDefined();
    adapter.destroy();
  });

  it('MOVES the binding when the Hub rotates a contract the log indexes', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(RETIRED_CG_STORAGE);

    // The Hub rebinds the name; `initContracts` re-resolves it, which is what
    // this assignment stands in for.
    stubContextGraphStorage(adapter, ROTATED_CG_STORAGE);
    dispatchHubRotation(adapter, 'ContextGraphStorage');

    // FIRST, and synchronously: the binding is gone. Everything the runtime
    // decides — its decoders, its floors, the addresses it publishes — was
    // fixed at construction, so until it is rebuilt the only honest thing it
    // can say is nothing, and every reader goes back to its own scan.
    expect(adapter.chainEventLog).toBeUndefined();

    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    // The one that matters. A binding still naming the retired proxy is a log
    // that answers "covered, and nothing happened" for every event the new
    // contract emits, and the lanes advance past them for good.
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(ROTATED_CG_STORAGE);
    adapter.destroy();
  });

  it('builds from the contracts it held when it STARTED, not from after the await', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    const internals = adapter as unknown as {
      contracts: Record<string, unknown>;
      resolveContractDeployBlockNumber: unknown;
    };
    let release = (): void => {};
    const searching = new Promise<void>((resolve) => { release = () => { resolve(); }; });
    internals.resolveContractDeployBlockNumber = async () => {
      await searching;
      return 1;
    };

    startChainIndex(adapter);
    // What `invalidateHubBinding` does, landing while this detached build sits
    // inside a deploy-block search.
    internals.contracts.contextGraphStorage = undefined;
    release();
    await chainIndexOwner(adapter).starting;

    // Read after the await, that null would have built a log with no Context
    // Graph source at all — every reader falling back forever, for the lifetime
    // of the process, with nothing but a `console.warn` to say so.
    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(RETIRED_CG_STORAGE);
    adapter.destroy();
  });

  it('leaves the log alone for a rotation of a contract it does not index', async () => {
    const store = new MemoryChainEventLogStore();
    const adapter = new EVMChainAdapter(config(store));
    stubHub(adapter);
    stubContextGraphStorage(adapter, RETIRED_CG_STORAGE);
    startChainIndex(adapter);
    await vi.waitUntil(() => adapter.chainEventLog !== undefined, { timeout: 2_000 });
    const binding = adapter.chainEventLog;

    // `ParametersStorage` is not in the tick's address array, so nothing about
    // the log became wrong. Tearing it down would spend a fresh deploy-block
    // search and a cold pass on every unrelated rotation.
    dispatchHubRotation(adapter, 'ParametersStorage');

    expect(adapter.chainEventLog).toBe(binding);
    adapter.destroy();
  });

  it('takes its interval from chain.indexTickMs and refuses an invalid one', async () => {
    const store = new MemoryChainEventLogStore();
    const rejected = new EVMChainAdapter({ ...config(store), indexTickMs: 0 });
    stubHub(rejected);
    startChainIndex(rejected);
    await chainIndexOwner(rejected).starting;

    // An operator who mis-set T must not silently get a tick on some other
    // cadence: every staleness bound on this node is derived from that number.
    expect(rejected.chainEventLog).toBeUndefined();
    rejected.destroy();

    const accepted = new EVMChainAdapter({ ...config(store), indexTickMs: 12_000 });
    stubHub(accepted);
    startChainIndex(accepted);
    await chainIndexOwner(accepted).starting;
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
