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

  it('the PCA rpc proxy: TIP methods are transparent, but receipt/exact-block reads stay sticky', async () => {
    const a = makeAdapter();
    const readProvider = recorder(async () => '0x10');
    a.readProvider = readProvider;

    // eth_blockNumber → TIP → skipPreferred (transparent).
    await a.requestPublishingConvictionRpc('eth_blockNumber', []);
    expect(readProvider.calls.find((c: any[]) => c[0] === 'pca rpc eth_blockNumber')![2])
      .toMatchObject({ skipPreferred: true });

    // EVERY latest-family eth_getBlockByNumber tag → TIP → skipPreferred (a
    // regression dropping any one of them from PCA_TIP_BLOCK_TAGS is caught here).
    for (const blockTag of ['latest', 'pending', 'safe', 'finalized']) {
      readProvider.calls.length = 0;
      await a.requestPublishingConvictionRpc('eth_getBlockByNumber', [blockTag, false]);
      expect(readProvider.calls.find((c: any[]) => c[0] === 'pca rpc eth_getBlockByNumber')![2])
        .toMatchObject({ skipPreferred: true });
    }

    readProvider.calls.length = 0;
    // eth_getTransactionReceipt → NOT a tip read → STICKY (no skipPreferred), so a
    // lagging primary's null doesn't short-circuit the backup that has the receipt.
    await a.requestPublishingConvictionRpc('eth_getTransactionReceipt', ['0xhash']);
    const receiptCall = readProvider.calls.find((c: any[]) => c[0] === 'pca rpc eth_getTransactionReceipt');
    expect(receiptCall).toBeDefined();
    expect(receiptCall![2]?.skipPreferred).toBeUndefined();

    readProvider.calls.length = 0;
    // eth_getBlockByNumber(concrete block) → NOT tip → STICKY.
    await a.requestPublishingConvictionRpc('eth_getBlockByNumber', ['0x7b', false]);
    const exactBlockCall = readProvider.calls.find((c: any[]) => c[0] === 'pca rpc eth_getBlockByNumber' && !c[2]?.skipPreferred);
    expect(exactBlockCall).toBeDefined();

    // eth_call with NO block tag (defaults to latest) OR a latest-family tag → TIP
    // (reads current contract state a lagging backend would stale) → skipPreferred.
    for (const callParams of [[{ to: '0xC', data: '0x' }], [{ to: '0xC', data: '0x' }, 'latest']]) {
      readProvider.calls.length = 0;
      await a.requestPublishingConvictionRpc('eth_call', callParams);
      expect(readProvider.calls.find((c: any[]) => c[0] === 'pca rpc eth_call')![2])
        .toMatchObject({ skipPreferred: true });
    }

    readProvider.calls.length = 0;
    // eth_call at a CONCRETE historical block → the answer can't change → STICKY.
    await a.requestPublishingConvictionRpc('eth_call', [{ to: '0xC', data: '0x' }, '0x7b']);
    const exactCall = readProvider.calls.find((c: any[]) => c[0] === 'pca rpc eth_call');
    expect(exactCall![2]?.skipPreferred).toBeUndefined();
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

// getBlockTimestamp is a CONCRETE receipt-block read (NOT the tip), so it is NOT a
// skipPreferred carve-out; instead a `null` (endpoint hasn't imported the block)
// must fail over rather than force a bogus `0` (#C, otReviewAgent 🔴).
describe('getBlockTimestamp: a null (unimported) receipt block fails over instead of returning 0', () => {
  function makeTwoEndpointAdapter(p0: any, p1: any) {
    const a: any = new EVMChainAdapter(minimalConfig());
    a.initialized = true;
    a.init = async () => { a.initialized = true; };
    a.ensureConfiguredStaticChainIdValidated = async () => {};
    a.providers = [p0, p1];
    a.rpcUrls = ['https://primary.example', 'https://backup.example'];
    return a;
  }

  it('primary returns null for the receipt block → fails over to the backup timestamp', async () => {
    const primaryGetBlock = recorder(async () => null); // lagging: block not imported yet
    const backupGetBlock = recorder(async () => ({ timestamp: 42 }));
    const a = makeTwoEndpointAdapter({ getBlock: primaryGetBlock }, { getBlock: backupGetBlock });
    expect(await a.getBlockTimestamp(123n)).toBe(42); // NOT 0 — the backup served the block
    expect(primaryGetBlock.calls).toHaveLength(1);
    expect(backupGetBlock.calls).toHaveLength(1);
  });

  it('all endpoints lack the block → best-effort 0 (callers tolerate it)', async () => {
    const a = makeTwoEndpointAdapter({ getBlock: recorder(async () => null) }, { getBlock: recorder(async () => null) });
    expect(await a.getBlockTimestamp(123n)).toBe(0);
  });

  it('a NON-RETRYABLE provider error PROPAGATES — it is NOT masked as timestamp 0', async () => {
    // The `0` fallback is scoped to the "block not imported anywhere" sentinel; a
    // deterministic provider error (INVALID_ARGUMENT) must surface to the caller.
    const invalidArg = () => { const e: any = new Error('bad blocktag'); e.code = 'INVALID_ARGUMENT'; return e; };
    const a = makeTwoEndpointAdapter(
      { getBlock: recorder(async () => { throw invalidArg(); }) },
      { getBlock: recorder(async () => ({ timestamp: 42 })) },
    );
    await expect(a.getBlockTimestamp(123n)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('a full transport EXHAUSTION (all endpoints error) PROPAGATES — not masked as timestamp 0', async () => {
    const retryable429 = () => { const e: any = new Error('429 too many requests'); e.status = 429; return e; };
    const a = makeTwoEndpointAdapter(
      { getBlock: recorder(async () => { throw retryable429(); }) },
      { getBlock: recorder(async () => { throw retryable429(); }) },
    );
    // Exhaustion whose cause is a transport error (NOT the not-imported sentinel)
    // propagates as RPC_ENDPOINTS_EXHAUSTED, not a bogus 0.
    await expect(a.getBlockTimestamp(123n)).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
  });

  it('MIXED null + transport error PROPAGATES regardless of endpoint order (order-independent, round-6 🔴)', async () => {
    const retryable429 = () => { const e: any = new Error('429 too many requests'); e.status = 429; return e; };
    // Order A: primary transport error, backup null. A transport failure occurred,
    // so we canNOT conclude "block not imported anywhere" → propagate (not 0).
    const orderA = makeTwoEndpointAdapter(
      { getBlock: recorder(async () => { throw retryable429(); }) },
      { getBlock: recorder(async () => null) },
    );
    await expect(orderA.getBlockTimestamp(123n)).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    // Order B: primary null, backup transport error — SAME endpoint states, so the
    // result must be identical (before the fix this returned 0 vs threw by order).
    const orderB = makeTwoEndpointAdapter(
      { getBlock: recorder(async () => null) },
      { getBlock: recorder(async () => { throw retryable429(); }) },
    );
    await expect(orderB.getBlockTimestamp(123n)).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
  });
});

// A nullable PCA proxy lookup (receipt/tx/block) whose queried endpoint returns
// `null` must FAIL OVER (a lagging endpoint's null is "not here yet", not a
// definitive answer) — otherwise the browser sees a stale null while another
// endpoint already has the object (round-5 🔴).
describe('PCA proxy nullable lookups fail over on null instead of returning a lagging stale null', () => {
  function makePca(p0: any, p1: any) {
    const a: any = new EVMChainAdapter(minimalConfig());
    a.initialized = true;
    a.init = async () => { a.initialized = true; };
    a.ensureConfiguredStaticChainIdValidated = async () => {};
    a.providers = [p0, p1];
    a.rpcUrls = ['https://primary.example', 'https://backup.example'];
    return a;
  }

  it('primary returns null for the receipt → fails over to the backup that HAS it', async () => {
    const receipt = { status: '0x1', transactionHash: '0xhash' };
    const primarySend = recorder(async () => null);   // lagging: no receipt yet
    const backupSend = recorder(async () => receipt); // has it
    const a = makePca({ send: primarySend }, { send: backupSend });
    expect(await a.requestPublishingConvictionRpc('eth_getTransactionReceipt', ['0xhash'])).toBe(receipt);
    expect(primarySend.calls).toHaveLength(1);
    expect(backupSend.calls).toHaveLength(1);
  });

  it('no endpoint has it yet → returns the honest null (after trying ALL endpoints)', async () => {
    const primarySend = recorder(async () => null);
    const backupSend = recorder(async () => null);
    const a = makePca({ send: primarySend }, { send: backupSend });
    expect(await a.requestPublishingConvictionRpc('eth_getTransactionReceipt', ['0xhash'])).toBeNull();
    expect(primarySend.calls).toHaveLength(1); // both endpoints were tried before returning null
    expect(backupSend.calls).toHaveLength(1);
  });

  it('eth_getTransactionByHash and a concrete eth_getBlockByNumber ALSO fail over on null (round-6 🟡 coverage)', async () => {
    const tx = { hash: '0xhash', blockNumber: '0x7b' };
    const txAdapter = makePca({ send: recorder(async () => null) }, { send: recorder(async () => tx) });
    expect(await txAdapter.requestPublishingConvictionRpc('eth_getTransactionByHash', ['0xhash'])).toBe(tx);

    const block = { number: '0x7b', timestamp: '0x1' };
    const blockAdapter = makePca({ send: recorder(async () => null) }, { send: recorder(async () => block) });
    expect(await blockAdapter.requestPublishingConvictionRpc('eth_getBlockByNumber', ['0x7b', false])).toBe(block);
  });

  it('MIXED null + transport error PROPAGATES regardless of endpoint order (order-independent, round-6 🔴)', async () => {
    const retryable429 = () => { const e: any = new Error('429 too many requests'); e.status = 429; return e; };
    const orderA = makePca({ send: recorder(async () => { throw retryable429(); }) }, { send: recorder(async () => null) });
    await expect(orderA.requestPublishingConvictionRpc('eth_getTransactionReceipt', ['0xhash']))
      .rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    const orderB = makePca({ send: recorder(async () => null) }, { send: recorder(async () => { throw retryable429(); }) });
    await expect(orderB.requestPublishingConvictionRpc('eth_getTransactionReceipt', ['0xhash']))
      .rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
  });
});
