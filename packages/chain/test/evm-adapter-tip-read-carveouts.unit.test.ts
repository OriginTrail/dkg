/**
 * Endpoint-stickiness (Mechanism B) carve-out PINS. The tip-sensitive reads that
 * advance a cursor or gate an expiry MUST stay canonical-order + preference-
 * transparent (`skipPreferred: true`) — a lagging sticky backend would make the
 * head non-monotonic (event-lane cursor rewind / proof-challenge instability) or
 * return a stale `latest` timestamp. These per-site assertions guard against a
 * refactor silently dropping the flag (which otherwise passes green — the flag
 * only changes behavior once a preference is established). Mirrors the poller pin
 * in hub-rotation-poller.unit.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
    ...overrides,
  };
}

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function makeAdapter() {
  const a: any = new EVMChainAdapter(minimalConfig());
  a.initialized = true;
  a.init = async () => { a.initialized = true; };
  return a;
}

describe('endpoint-stickiness carve-outs: tip-sensitive reads pass skipPreferred:true', () => {
  it('getBlockNumber() reads canonical + preference-transparent', async () => {
    const a = makeAdapter();
    const readProvider = recorder(async () => 100);
    a.readProvider = readProvider;
    expect(await a.getBlockNumber()).toBe(100);
    const call = readProvider.calls.find((c: any[]) => c[0] === 'getBlockNumber');
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ skipPreferred: true });
  });

  it('getBlockTimestamp(n) reads canonical + preference-transparent', async () => {
    const a = makeAdapter();
    const readProvider = recorder(async () => ({ timestamp: 42 }));
    a.readProvider = readProvider;
    expect(await a.getBlockTimestamp(5n)).toBe(42);
    const call = readProvider.calls.find((c: any[]) => c[0] === 'getBlock');
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ skipPreferred: true });
  });

  it("conviction getBlock('latest') reads canonical + preference-transparent", async () => {
    const a = makeAdapter();
    a.contracts = { dkgPublishingConvictionNFT: {} };
    a.getPublishingConvictionAccountInfo = async () => ({ expiresAtTimestamp: 9_999_999_999 });
    const readProvider = recorder(async () => ({ timestamp: 0 })); // nowTs 0 < expiry → continues past the gate
    a.readProvider = readProvider;
    // convictionAccountCanCover reaches the `latest` read inside the expiry gate.
    await a.convictionAccountCanCover(1n, 100n).catch(() => {});
    const call = readProvider.calls.find((c: any[]) => c[0] === 'conviction getBlock');
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ skipPreferred: true });
  });

  it('the PCA rpc proxy (send) reads canonical + preference-transparent', async () => {
    const a = makeAdapter();
    const readProvider = recorder(async () => '0x10');
    a.readProvider = readProvider;
    expect(await a.requestPublishingConvictionRpc('eth_blockNumber', [])).toBe('0x10');
    const call = readProvider.calls.find((c: any[]) => c[0] === 'pca rpc eth_blockNumber');
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ skipPreferred: true });
  });

  it('the event-lane wide-log scan (listenForEvents → queryFilter) reads canonical + preference-transparent', async () => {
    const a = makeAdapter();
    a.contracts = {
      knowledgeAssetsStorage: {
        filters: { KnowledgeBatchCreated: () => ({}) },
        interface: { parseLog: () => null },
      },
    };
    const readContractWith = recorder(async () => []); // intercept the scan, return no logs
    a.readContractWith = readContractWith;
    // Drain the async generator; the KnowledgeBatchCreated branch runs the scan.
    // eslint-disable-next-line no-empty
    for await (const _ of a.listenForEvents({ eventTypes: ['KnowledgeBatchCreated'], fromBlock: 0 })) { void _; }
    expect(readContractWith.calls).toHaveLength(1);
    expect(readContractWith.calls[0][3]).toMatchObject({ policy: 'wideLogScan', skipPreferred: true });
  });
});
