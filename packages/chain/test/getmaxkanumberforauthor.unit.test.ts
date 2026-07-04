/**
 * `EVMChainAdapter.getMaxKaNumberForAuthor` — OT-RFC-43 Option 1 / issue #1080.
 *
 * Verifies the wiring of the on-chain getter:
 *   1. Prefers the O(1) `getMaxKaNumberForAuthor(address) -> int256` view (a
 *      single eth_call) and does NOT scan logs when the view answers.
 *   2. Falls back to a PAGINATED, RPC-safe (<= 2000-block window) log scan when
 *      the view is absent or the selector call cannot be decoded on older
 *      deployments. The fallback must never use the old unbounded
 *      `queryFilter(filter, 0)` shape that overflowed provider eth_getLogs caps.
 *   3. Propagates transient RPC failures instead of hiding them behind a
 *      historical crawl on the same provider.
 *
 * Private state is injected via `as any`, the same convention the rest of the
 * chain unit tests use. The injected provider/storage seams are plain hand-rolled
 * recorders (no vitest mock API): the code under test is REAL, but these RPC-fault /
 * decode-error / deploy-search / failover branches cannot be driven by a real chain,
 * so the seam is a controlled recorder per the no-mocks DI-seam rule.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { RPC_READ_STALL_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import { connectable } from './connectable.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

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

const AUTHOR = ethers.getAddress('0x1111111111111111111111111111111111111111');
const pack = (n: bigint) => (BigInt(AUTHOR) << 96n) | n; // packed kaId for AUTHOR
const EMPTY_VIEW_RESULT = 'could not decode result data (value="0x", info={ method: "getMaxKaNumberForAuthor", signature: "getMaxKaNumberForAuthor(address)" }, code=BAD_DATA, version=6.16.0)';

/** A ContractMethod-shaped double: a function carrying a `.staticCall` recorder. */
function viewMock(impl: () => Promise<bigint>) {
  const fn: any = recorder(() => undefined);
  fn.staticCall = recorder(impl);
  return fn;
}

function makeAdapter(storage: any, head = 0) {
  const a = new EVMChainAdapter(minimalConfig());
  storage.target ??= '0x2222222222222222222222222222222222222222';
  // The scan runs on storage.connect(scanProvider); the double returns itself so
  // its queryFilter is exercised (and records which provider it was bound to).
  storage.connect ??= recorder(() => storage);
  (a as any).contracts = { knowledgeAssetStorage: storage };
  // getMaxKaNumberForAuthor now `await this.init()`s first (re-resolve handles
  // on Hub rotation). Mark initialized so init() short-circuits and the injected
  // handle is used; the post-rotation test below exercises the
  // initialized=false re-resolution path explicitly.
  (a as any).initialized = true;
  (a as any).provider = {
    getBlockNumber: recorder(async () => head),
    getCode: recorder(async () => '0x6000'),
  };
  // The deploy-block search iterates this.providers (per-backend consistency +
  // failover); default it to the single scan-provider double here.
  (a as any).providers = [(a as any).provider];
  return a;
}

describe('EVMChainAdapter.getMaxKaNumberForAuthor — view + bounded fallback (#1080)', () => {
  it('uses the O(1) on-chain view and never scans logs when the view answers', async () => {
    const queryFilter = recorder(() => undefined);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => 5n),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 9_999_999);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n);
    expect(storage.getMaxKaNumberForAuthor.staticCall.calls).toHaveLength(1);
    expect(storage.getMaxKaNumberForAuthor.staticCall.calls.at(-1)).toEqual([AUTHOR]);
    expect(queryFilter.calls).toEqual([]);
    expect((a as any).provider.getBlockNumber.calls).toEqual([]);
  });

  it('returns -1n for a never-minted author (allocator next number = 0)', async () => {
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => -1n),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter: recorder(() => undefined),
    };
    expect(await makeAdapter(storage).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    expect(storage.queryFilter.calls).toEqual([]);
  });

  it('falls back to a paginated bounded scan when the view is absent', async () => {
    const head = 5_000;
    const queryFilter = recorder(async (_f: unknown, lo: number, hi: number) =>
      lo <= 2500 && 2500 <= hi ? [{ args: { id: pack(7n) } }] : [],
    );
    const storage = {
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(7n);
    expect(queryFilter.calls).toHaveLength(3);
    for (const [, lo, hi] of queryFilter.calls as unknown as [unknown, number, number][]) {
      expect(typeof lo).toBe('number');
      expect(typeof hi).toBe('number');
      expect(hi - lo + 1).toBeLessThanOrEqual(2000);
    }
    expect(queryFilter.calls).toEqual([
      ['F', 0, 1999],
      ['F', 2000, 3999],
      ['F', 4000, 5000],
    ]);
  });

  it('falls back to the bounded scan when an older deployment cannot decode the view result', async () => {
    const badData: any = new Error(EMPTY_VIEW_RESULT);
    badData.code = 'BAD_DATA';
    const view = viewMock(async () => {
      throw badData;
    });
    const queryFilter = recorder(async () => [{ args: { id: pack(3n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: view,
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };

    expect(await makeAdapter(storage, 1_500).getMaxKaNumberForAuthor(AUTHOR)).toBe(3n);
    expect(view.staticCall.calls).toHaveLength(1);
    expect(queryFilter.calls.at(-1)).toEqual(['F', 0, 1500]);
  });

  it('fails loudly instead of scanning empty logs when the resolved storage address has no code', async () => {
    const badData: any = new Error(EMPTY_VIEW_RESULT);
    badData.code = 'BAD_DATA';
    const queryFilter = recorder(async () => []);
    const storage = {
      target: '0x3333333333333333333333333333333333333333',
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw badData;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    // First getCode probe returns '0x' (no code), then defaults to '0x6000'.
    const getCodeQueue = ['0x'];
    (a as any).provider.getCode = recorder(async () => getCodeQueue.shift() ?? '0x6000');

    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(
      'no contract code is deployed there',
    );
    expect((a as any).provider.getCode.calls.at(-1)).toEqual([storage.target]);
    expect(queryFilter.calls).toEqual([]);
    expect((a as any).provider.getBlockNumber.calls).toEqual([]);
  });

  it('returns -1n when neither the view nor legacy logs yields a number', async () => {
    const storage = {
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter: recorder(async () => []),
    };
    expect(await makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
  });

  it('rethrows a transient RPC error from the view instead of crawling logs', async () => {
    const err: any = new Error('rate limited');
    err.code = 'SERVER_ERROR';
    const queryFilter = recorder(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('rate limited');
    expect(queryFilter.calls).toEqual([]);
  });

  it('rethrows non-selector CALL_EXCEPTION errors instead of treating them as absent view', async () => {
    const err: any = new Error('execution reverted: Paused');
    err.code = 'CALL_EXCEPTION';
    const queryFilter = recorder(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('Paused');
    expect(queryFilter.calls).toEqual([]);
  });

  it('re-resolves the DKGKnowledgeAssets handle after a Hub rotation rather than querying the stale pre-rotation contract (#1082 review)', async () => {
    // Long-lived adapter after the 10.0.4 redeploy: the rotation listener has
    // set `initialized = false` but the cached binding still points at the OLD
    // contract. The getter must `await this.init()` to re-resolve before
    // reading, or it answers from the pre-rotation DKGKnowledgeAssets.
    const mkStorage = (n: bigint) => connectable({
      getMaxKaNumberForAuthor: viewMock(async () => n),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter: recorder(() => undefined),
      target: '0x2222222222222222222222222222222222222222',
    });
    const stale = mkStorage(99n);
    const fresh = mkStorage(7n);

    const a = new EVMChainAdapter(minimalConfig());
    (a as any).contracts = { knowledgeAssetStorage: stale };
    (a as any).initialized = false; // post-rotation: handles need re-resolving
    (a as any).provider = {
      getBlockNumber: recorder(async () => 0),
      getCode: recorder(async () => '0x6000'),
    };
    // What the real init() does on a re-init: swap in the fresh binding.
    const init = recorder(async () => {
      (a as any).contracts.knowledgeAssetStorage = fresh;
      (a as any).initialized = true;
    });
    (a as any).init = init;

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(7n); // FRESH, not stale 99n
    expect(init.calls).toHaveLength(1);
    expect(fresh.getMaxKaNumberForAuthor.staticCall.calls).toHaveLength(1);
    expect(stale.getMaxKaNumberForAuthor.staticCall.calls).toEqual([]);
  });

  // The view staticCall now routes THROUGH readProvider (this.rpcFailover.read,
  // #1336) with a CUSTOM classifier (isRetryableRpcError minus the absent-view /
  // bareRevert shapes), giving it the per-attempt stall timeout + endpoint failover
  // the old bespoke loop lacked — while preserving the boundary: a TRANSIENT error
  // fails over to the next endpoint, but a DETERMINISTIC absent-view
  // (BAD_DATA/CALL_EXCEPTION) is non-retryable -> rethrown straight to the catch
  // -> the pre-10.0.4 scan (never failed over / masked as RPC_ENDPOINTS_EXHAUSTED).
  it('getMaxKaNumber view (readProvider): a TRANSIENT 429 fails over to the next endpoint and answers from the view (no scan)', async () => {
    const queryFilter = recorder(async () => []);
    let attempt = 0;
    const storage: any = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        attempt += 1;
        if (attempt === 1) { const e: any = new Error('429 too many requests'); e.status = 429; throw e; }
        return 5n;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100_000);
    (a as any).providers = [{}, {}]; // two endpoints → the view read fails over
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n); // served by endpoint #2
    expect(storage.getMaxKaNumberForAuthor.staticCall.calls).toHaveLength(2); // failed over once
    expect(queryFilter.calls).toEqual([]); // the view answered → NEVER scans logs
  });

  it('getMaxKaNumber view (readProvider): an ABSENT-view (BAD_DATA) is deterministic across endpoints — no failover, straight to the scan', async () => {
    const badData: any = new Error(EMPTY_VIEW_RESULT);
    badData.code = 'BAD_DATA';
    const queryFilter = recorder(async () => []);
    const storage: any = {
      target: '0x5555555555555555555555555555555555555555',
      getMaxKaNumberForAuthor: viewMock(async () => { throw badData; }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 3_000);
    const backend = () => ({ getBlockNumber: recorder(async () => 3_000), getCode: recorder(async () => '0x6000') });
    (a as any).providers = [backend(), backend()];
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n); // degraded to the (empty) scan
    // Absent-view is non-retryable → rethrown after ONE attempt, endpoint #2 never consulted.
    expect(storage.getMaxKaNumberForAuthor.staticCall.calls).toHaveLength(1);
    expect(queryFilter.calls.length).toBeGreaterThan(0); // the scan ran instead
  });

  it('getMaxKaNumber view (readProvider): a HUNG primary staticCall times out (per-attempt cap the bespoke loop lacked) and fails over to the backup', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const storage: any = {
        getMaxKaNumberForAuthor: viewMock(() =>
          (attempt += 1) === 1
            ? new Promise<bigint>(() => {}) // primary hangs forever
            : Promise.resolve(7n)),         // backup answers
        filters: { KnowledgeAssetCreated: recorder(() => 'F') },
        queryFilter: recorder(async () => []),
      };
      const a = makeAdapter(storage, 100_000);
      (a as any).providers = [{}, {}];
      const p = a.getMaxKaNumberForAuthor(AUTHOR);
      // The new readProvider cap aborts the hung primary at the 4s multi-RPC
      // default and fails over (the old bespoke loop had NO per-attempt timeout →
      // a hung backend stalled the whole resolution).
      await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS + 500);
      expect(await p).toBe(7n); // answered by the backup's staticCall
      expect(storage.getMaxKaNumberForAuthor.staticCall.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows malformed BAD_DATA instead of treating every decode failure as an absent view', async () => {
    const err: any = new Error(
      'could not decode result data (value="0x1234", info={ method: "getMaxKaNumberForAuthor", signature: "getMaxKaNumberForAuthor(address)" }, code=BAD_DATA, version=6.16.0)',
    );
    err.code = 'BAD_DATA';
    const queryFilter = recorder(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('0x1234');
    expect(queryFilter.calls).toEqual([]);
  });

  // #1080 follow-up: a pre-10.0.4 deployment that lacks the selector reverts with
  // CALL_EXCEPTION / "missing revert data" on RPCs like Base Sepolia (no BAD_DATA
  // shape). That is the user-observed failure: it MUST fall back to the scan, not
  // rethrow — but only once the deployed bytecode confirms the selector is absent.
  const VIEW_SELECTOR = '0xe9ed840f'; // getMaxKaNumberForAuthor(address)
  const ifaceWithSelector = { getFunction: () => ({ selector: VIEW_SELECTOR }) };

  it('falls back when a pre-10.0.4 deployment reverts with missing-revert-data and the selector is ABSENT from bytecode', async () => {
    const err: any = new Error(
      'missing revert data (action="call", data=null, reason=null, code=CALL_EXCEPTION, version=6.16.0)',
    );
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = recorder(async () => [{ args: { id: pack(4n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 1_500);
    (a as any).provider.getCode = recorder(async () => '0x6000'); // code, but no selector

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(4n);
    expect(queryFilter.calls.at(-1)).toEqual(['F', 0, 1500]);
  });

  it('rethrows missing-revert-data when the view selector IS present in the deployed bytecode (genuine bare revert)', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = recorder(async () => [{ args: { id: pack(9n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode = recorder(async () => `0x600063${VIEW_SELECTOR.slice(2)}6001`); // PUSH4 <selector> dispatcher entry

    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('missing revert data');
    expect(queryFilter.calls).toEqual([]);
  });

  it('treats a coincidental selector byte-run (no PUSH4 prefix) as absent and falls back, not rethrow', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = recorder(async () => [{ args: { id: pack(5n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 1_000);
    // selector bytes present in a constant/metadata blob, but NOT as a `63<selector>` dispatcher entry
    (a as any).provider.getCode = recorder(async () => `0x60ff${VIEW_SELECTOR.slice(2)}00`);
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n); // view is genuinely absent → scan
    expect(queryFilter.calls.length).toBeGreaterThan(0);
  });

  it('anchors the fallback scan at the contract deploy block, not genesis (#1080 — avoids a 2,000-cap full-history crawl)', async () => {
    const head = 42_650_000;
    const deployBlock = 42_410_000; // ~240k blocks of lifetime => ~120 pages, not ~21k
    const queryFilter = recorder(async () => []);
    const storage: any = {
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head); // no view fn => straight to fallback
    // historical getCode: '0x' before deploy, code at/after deploy
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) =>
      block === undefined || block >= deployBlock ? '0x6000' : '0x',
    );

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    const firstLo = (queryFilter.calls[0] as unknown as [unknown, number, number])[1];
    const lastHi = (queryFilter.calls.at(-1) as unknown as [unknown, number, number])[2];
    expect(firstLo).toBe(deployBlock); // anchored, NOT 0
    expect(lastHi).toBe(head);
    // ~120 pages over the contract's lifetime, far below a from-genesis ~21k.
    expect(queryFilter.calls.length).toBe(Math.ceil((head - deployBlock + 1) / 2000));
    expect(queryFilter.calls.length).toBeLessThan(200);
  });

  it('fails loudly (no storm) when the anchored fallback would exceed the eth_getLogs page budget', async () => {
    const head = 80_000_000;
    const queryFilter = recorder(async () => []);
    const storage: any = {
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) =>
      block === undefined || block >= 0 ? '0x6000' : '0x',
    ); // deploys at genesis => ~40k pages, over the cap

    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(/eth_getLogs calls|deploy DKGKnowledgeAssets >= 10\.0\.4/);
    expect(queryFilter.calls).toEqual([]);
  });

  // Pin the hasRevertPayload early-return in isKaHighWaterBareRevert: a
  // CALL_EXCEPTION whose message contains "missing revert data" but which
  // carries a reason/data is a GENUINE revert from an existing view and must
  // rethrow, not fall back — even though its message matches the bare shape.
  it('rethrows a CALL_EXCEPTION that says missing-revert-data but carries a reason (genuine revert)', async () => {
    const err: any = new Error('missing revert data: execution reverted');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = 'Paused';
    const queryFilter = recorder(async () => [{ args: { id: pack(9n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode = recorder(async () => '0x6000'); // selector absent — must STILL rethrow
    // hasRevertPayload trips on the `reason` even though the message matches the
    // bare shape and the selector is absent → rethrown (the original error), not scanned.
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('missing revert data');
    expect(queryFilter.calls).toEqual([]);
  });

  it('rethrows a CALL_EXCEPTION that says missing-revert-data but carries revert data (genuine revert)', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = '0x08c379a0000000000000000000000000000000000000000000000000000000000000'; // Error(string) selector
    err.reason = null;
    const queryFilter = recorder(async () => [{ args: { id: pack(9n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode = recorder(async () => '0x6000');
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('missing revert data');
    expect(queryFilter.calls).toEqual([]);
  });

  it('binary-searches the deploy block once and reuses the cached value on later calls', async () => {
    const head = 100_000;
    const deployBlock = 90_000;
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    let getCode = recorder(async (_addr: string, block?: number) =>
      block === undefined || block >= deployBlock ? '0x6000' : '0x',
    );
    (a as any).provider.getCode = getCode;

    await a.getMaxKaNumberForAuthor(AUTHOR);
    const searchCalls1 = getCode.calls.filter((c) => c.length === 2).length;
    expect(searchCalls1).toBeGreaterThan(0); // first call binary-searches
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBe(deployBlock);

    // fresh recorder for the second call (a cache hit must perform no search)
    getCode = recorder(async (_addr: string, block?: number) =>
      block === undefined || block >= deployBlock ? '0x6000' : '0x',
    );
    (a as any).provider.getCode = getCode;
    await a.getMaxKaNumberForAuthor(AUTHOR);
    expect(getCode.calls.filter((c) => c.length === 2).length).toBe(0); // cache hit: no second search
  });

  it('falls back (not rethrow) on a bare revert when the view selector cannot be derived from the interface', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = recorder(async () => [{ args: { id: pack(2n) } }]);
    const storage: any = {
      interface: {
        getFunction: () => {
          throw new Error('no matching fragment');
        },
      },
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 1_000);
    (a as any).provider.getCode = recorder(async () => '0x6000');
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(2n); // un-derivable selector => treat as absent => scan
    expect(queryFilter.calls.length).toBeGreaterThan(0);
  });

  it('degrades to a genesis-anchored scan (not a hard fail) when historical getCode is unavailable, never anchoring above deploy', async () => {
    const head = 100_000; // short chain: from-0 is within budget (51 pages)
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    // latest getCode (1 arg) confirms code; historical getCode (2 args) throws (pruned/non-archive RPC)
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) throw new Error('missing trie node (pruned node)');
      return '0x6000';
    });

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n); // still scans — pruned RPCs serve queryFilter
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(0); // genesis (safe lower bound, never above deploy)
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBeUndefined(); // degraded anchor not cached
  });

  it('rethrows a transient throttle during the deploy-block search immediately (no degrade that would worsen the throttle)', async () => {
    const head = 100_000;
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) throw new Error('429 Too Many Requests: rate limit exceeded'); // transient throttle
      return '0x6000';
    });
    // A transient throttle is surfaced AT the deploy search (not failed-over /
    // degraded), so it never even reaches the log scan — degrading would only fire
    // getCode retries + a page-1 eth_getLogs that worsen the throttle. (A STATIC
    // access/plan/archive denial would instead degrade — see the degrade cases.)
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('Too Many Requests');
    expect(queryFilter.calls).toEqual([]); // not degraded into a log crawl
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBeUndefined();
  });

  it('surfaces a DEEPLY-NESTED 429 status even when the message text looks like pruned state (#1111 review)', async () => {
    const head = 100_000;
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    // A managed RPC buries the throttle status at `cause.info.error.status` while
    // concatenating the upstream node's `missing trie node` text into the message.
    // The recursive `errorStatus` must find the 429 so the classifier surfaces the
    // throttle instead of degrading into a genesis sweep that worsens it.
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) {
        const err: any = new Error('missing trie node');
        err.cause = { info: { error: { status: 429, message: 'rate exceeded' } } };
        throw err;
      }
      return '0x6000';
    });
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(); // surfaced, not degraded
    expect(queryFilter.calls).toEqual([]); // NOT degraded into a log sweep despite the "missing trie node" text
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBeUndefined();
  });

  it('does NOT silently mask a BARE "header not found" — it is not historical-state, so it surfaces via the scan (#1111 review)', async () => {
    const head = 100_000;
    // A bare "header not found" (NO pruned/archive companion phrase) is a transient
    // sync/restart fault, NOT a historical-state-unavailable signal — so it is not
    // in the degrade allow-list (thread M). An out-of-sync node that returns it on
    // getCode also can't serve the log range, so the scan surfaces it on page 1
    // (NOT a 1,500-page sweep against the unhealthy backend, and NOT a silent
    // -1n).
    const queryFilter = recorder(async () => {
      throw new Error('header not found');
    });
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) throw new Error('header not found');
      return '0x6000';
    });
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('header not found'); // surfaced by the scan
    expect(queryFilter.calls).toHaveLength(1); // fails on page 1, no large sweep
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBeUndefined();
  });

  it('still degrades when "header not found" is accompanied by a genuine pruned-state phrase (#1111 review)', async () => {
    const head = 100_000;
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    // A real pruned node pairs the missing header with a pruned/archive phrase; the
    // companion phrase (here "missing trie node") still matches, so we degrade.
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) throw new Error('missing trie node: header not found for the requested historical block');
      return '0x6000';
    });
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n); // degraded to a genesis-anchored scan
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(0); // safe genesis lower bound
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBeUndefined();
  });

  it('degrades to genesis (never caches a stale head as the deploy block) when a backend head is behind the deploy block', async () => {
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, 50); // a lagging backend reports head=50, BEFORE deploy
    // untagged "latest" read shows code; tagged read at the stale head 50 shows none
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) =>
      block === undefined ? '0x6000' : '0x',
    );
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBeUndefined(); // stale head NOT cached as deploy block
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(0); // safe genesis lower bound
  });

  it('fails over to a healthy secondary backend for the deploy-block search when the first is pruned/lagging', async () => {
    const head = 20_000;
    const deployBlock = 12_000;
    const queryFilter = recorder(async () => []);
    const storage: any = {
      target: '0x2222222222222222222222222222222222222222',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);
    // backend 0: pruned — every tagged getCode is a historical-unavailable error
    const b0 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_addr: string, block?: number) => {
        if (block !== undefined) throw new Error('missing trie node');
        return '0x6000';
      }),
    };
    // backend 1: healthy archive — can pin the deploy block
    const b1 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_addr: string, block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x')),
    };
    (a as any).providers = [b0, b1];

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(deployBlock); // anchored via the healthy secondary
    expect(b1.getCode.calls.length).toBeGreaterThan(0); // failover used the secondary
  });

  it('drops a throttled backend from the scan even when another backend pins the deploy block (#1111 review)', async () => {
    const head = 20_000;
    const deployBlock = 12_000;
    const storage: any = {
      target: '0x8888888888888888888888888888888888888888',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
    };
    const a = makeAdapter(storage, 0);
    (storage as any).connect = (p: any) => ({ filters: storage.filters, queryFilter: p.qf });
    const throttledQF = recorder(async () => [{ args: { id: pack(9n) } }]); // must NOT be queried
    const healthyQF = recorder(async () => [{ args: { id: pack(4n) } }]);
    // b0 (freshest) throttles on getCode; b1 pins the deploy block. The anchored
    // scan must EXCLUDE the throttled b0 so it isn't re-queried (worsening it).
    const b0 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_a: string, block?: number) => {
        if (block !== undefined) throw new Error('429 too many requests');
        return '0x6000';
      }),
      qf: throttledQF,
    };
    const b1 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_a: string, block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x')),
      qf: healthyQF,
    };
    (a as any).providers = [b0, b1];

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(4n); // anchored at the deploy block, scanned via b1
    expect((healthyQF.calls[0] as unknown as [unknown, number, number])[1]).toBe(deployBlock); // anchored, not genesis
    expect(throttledQF.calls).toEqual([]); // throttled backend NOT re-queried by the scan
  });

  it('degrades to a genesis scan (not a throw) when one backend is transient on getCode and the log range is still servable (#1111 review)', async () => {
    const head = 20_000;
    // Neither backend can pin the deploy block: b0 hits a transient 503 on
    // historical getCode, b1 is pruned (missing trie node). But the log range is
    // still servable, so the fallback must DEGRADE to the genesis scan and return
    // the real max — one flaky archive endpoint must not abort the whole publish
    // path (thread R). (An access/throttle denial would instead surface; 503 is a
    // transient server error, not an auth/rate-limit denial.)
    const queryFilter = recorder(async () => [{ args: { id: pack(7n) } }]);
    const storage: any = {
      target: '0x6666666666666666666666666666666666666666',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
    };
    (storage as any).connect = () => ({ filters: storage.filters, queryFilter });
    const a = makeAdapter(storage, 0);
    const b0 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_a: string, block?: number) => {
        if (block !== undefined) throw new Error('503 Service Unavailable'); // transient, NOT auth/pruned
        return '0x6000';
      }),
    };
    const b1 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_a: string, block?: number) => {
        if (block !== undefined) throw new Error('missing trie node'); // pruned
        return '0x6000';
      }),
    };
    (a as any).providers = [b0, b1];

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(7n); // degraded + scanned, not aborted
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(0); // genesis lower bound
    expect((a as any).cachedContractDeployBlocks.get(storage.target.toLowerCase())).toBeUndefined(); // degraded anchor not cached
  });

  it('does not abort on a denied freshest backend — a healthy archive secondary still pins the deploy block (#1111 review)', async () => {
    const head = 20_000;
    const deployBlock = 12_000;
    const queryFilter = recorder(async () => []);
    const storage: any = {
      target: '0x7777777777777777777777777777777777777777',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);
    // b0 (freshest) is access-denied on getCode; the search must STILL fail over to
    // b1 and anchor at the real deploy block, not surface b0's 401 prematurely.
    const b0 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_a: string, block?: number) => {
        if (block !== undefined) throw new Error('403 Forbidden: archive not enabled on your plan');
        return '0x6000';
      }),
    };
    const b1 = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_a: string, block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x')),
    };
    (a as any).providers = [b0, b1];

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n); // completed via b1, not aborted on b0
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(deployBlock); // anchored via b1
    expect(b1.getCode.calls.length).toBeGreaterThan(0);
  });

  it('times out a backend that HANGS on the head probe and resolves via a healthy backend instead of stalling (#1111 review)', async () => {
    vi.useFakeTimers();
    try {
      const head = 20_000;
      const deployBlock = 12_000;
      const queryFilter = recorder(async () => [{ args: { id: pack(8n) } }]);
      const storage: any = {
        target: '0x4444444444444444444444444444444444444444',
        filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      };
      (storage as any).connect = () => ({ filters: storage.filters, queryFilter });
      const a = makeAdapter(storage, 0);
      // b0 HANGS forever on the head probe (getBlockNumber); b1 is healthy. The
      // per-backend probe timeout must drop b0 and let the resolution use b1.
      const code = (block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x');
      const b0 = { getBlockNumber: recorder(() => new Promise<number>(() => {})), getCode: recorder(async () => '0x6000') };
      const b1 = { getBlockNumber: recorder(async () => head), getCode: recorder(async (_a: string, block?: number) => code(block)) };
      (a as any).providers = [b0, b1];

      const resultP = a.getMaxKaNumberForAuthor(AUTHOR);
      await vi.advanceTimersByTimeAsync(5_000); // drive b0's 4s head-probe stall timeout
      expect(await resultP).toBe(8n); // resolved via b1 instead of hanging on b0
      expect(b1.getBlockNumber.calls.length).toBeGreaterThan(0);
      expect(queryFilter.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a backend that HANGS on getCode during the deploy-block search and fails over (#1111 review)', async () => {
    vi.useFakeTimers();
    try {
      const head = 20_000;
      const deployBlock = 12_000;
      const queryFilter = recorder(async () => []);
      const storage: any = {
        target: '0x5555555555555555555555555555555555555555',
        filters: { KnowledgeAssetCreated: recorder(() => 'F') },
        queryFilter,
      };
      const a = makeAdapter(storage, head);
      const code = (block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x');
      // b0 is reachable (head ok) and serves the STANDALONE bytecode probe
      // (block===undefined → readProvider, R1) but HANGS on the deploy-block
      // SEARCH reads (block!==undefined); the search must time out its 3×4s
      // attempts and fail over to b1 rather than stalling. (Hanging the
      // standalone probe too would add a 4s readProvider hop and push the
      // total past the 13s advance — out of scope for this "search fails over"
      // assertion.)
      const b0 = {
        getBlockNumber: recorder(async () => head),
        getCode: recorder((_a: string, block?: number) =>
          block === undefined ? Promise.resolve('0x6000') : new Promise<string>(() => {})),
      };
      const b1 = { getBlockNumber: recorder(async () => head), getCode: recorder(async (_a: string, block?: number) => code(block)) };
      (a as any).providers = [b0, b1];

      const resultP = a.getMaxKaNumberForAuthor(AUTHOR);
      // b0's getCode hangs: 3 retry attempts x 4s each = 12s before failover to b1.
      await vi.advanceTimersByTimeAsync(13_000);
      expect(await resultP).toBe(-1n); // resolved via b1's deploy search instead of stalling on b0
      expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(deployBlock); // anchored via b1
      expect(b1.getCode.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a valid kaHighWaterScanPageSize and defaults on a non-integer (no Infinity pages)', async () => {
    // valid integer window widens the scan
    const head = 30_000;
    const queryFilter = recorder(async () => []);
    const storage: any = {
      target: '0x2222222222222222222222222222222222222222',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    storage.connect = () => storage;
    const a = new EVMChainAdapter(minimalConfig({ kaHighWaterScanPageSize: 10_000 }));
    (a as any).contracts = { knowledgeAssetStorage: storage };
    (a as any).initialized = true;
    const prov = { getBlockNumber: recorder(async () => head), getCode: recorder(async () => '0x6000') };
    (a as any).provider = prov;
    (a as any).providers = [prov];
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[2]).toBe(9_999); // 10k window

    // fractional >= 1 floors (PRESERVES the window): 10000.5 -> 10000, not the default
    const big = new EVMChainAdapter(minimalConfig({ kaHighWaterScanPageSize: 10_000.5 }));
    expect((big as any).kaHighWaterScanPageSize).toBe(10_000);
    // only a (0,1) value would floor to 0 -> Infinity pages, so it falls back to the default
    const sub1 = new EVMChainAdapter(minimalConfig({ kaHighWaterScanPageSize: 0.5 }));
    expect((sub1 as any).kaHighWaterScanPageSize).toBe(2_000);
  });

  it('scans to the freshest head across backends (does not stop at a slightly-stale first backend)', async () => {
    const deployBlock = 12_000;
    const queryFilter = recorder(async () => []);
    const storage: any = {
      target: '0x2222222222222222222222222222222222222222',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 0);
    const code = (block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x');
    const b0 = { getBlockNumber: recorder(async () => 18_000), getCode: recorder(async (_a: string, block?: number) => code(block)) }; // first, slightly behind
    const b1 = { getBlockNumber: recorder(async () => 20_000), getCode: recorder(async (_a: string, block?: number) => code(block)) }; // freshest
    (a as any).providers = [b0, b1];

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    const lastHi = (queryFilter.calls.at(-1) as unknown as [unknown, number, number])[2];
    expect(lastHi).toBe(20_000); // freshest head, NOT b0's stale 18,000
    // the log crawl is bound to the freshest backend (b1), not the shared/lagging one
    expect((storage.connect as any).calls).toContainEqual([b1]);
  });

  it('wraps a deploy-block getCode failure with contract/block context and preserves the original as cause', async () => {
    const head = 100_000;
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    // A transient throttle surfaces (it does not degrade), so it exercises the
    // wrapped-with-context error path; a 503 / static plan denial would instead
    // degrade to the scan (covered by the degrade tests below).
    const orig = new Error('429 Too Many Requests: rate limit exceeded');
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) throw orig;
      return '0x6000';
    });
    const err = await a.getMaxKaNumberForAuthor(AUTHOR).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/eth_getCode for DKGKnowledgeAssets 0x[0-9a-fA-F]+ at block \d+/); // actionable context
    expect(err.cause).toBe(orig); // original preserved for diagnostics
    expect(queryFilter.calls).toEqual([]);
  });

  // The deploy-block search surfaces only a TRANSIENT throttle (degrading fires
  // getCode retries + a page-1 eth_getLogs that worsen it); everything else
  // degrades, since the scan does not need archive state. Uses REAL provider
  // throttle phrasings, including a throttle envelope that concatenates upstream
  // pruned text.
  const surfaceMessages = [
    'missing trie node ...; rate limit exceeded', // throttle envelope concatenating upstream pruned text
    'you have exceeded your compute units allowance', // Alchemy CU exhaustion
    'too many requests, please slow down', // generic throttle
    'request rate limit reached for your api key', // rate limit
  ];
  for (const message of surfaceMessages) {
    it(`surfaces (does not degrade) the transient throttle: "${message}"`, async () => {
      const queryFilter = recorder(async () => []);
      const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
      const a = makeAdapter(storage, 100_000);
      (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
        if (block !== undefined) throw new Error(message);
        return '0x6000';
      });
      await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(message.slice(-15));
      expect(queryFilter.calls).toEqual([]);
    });
  }

  it('surfaces a 429 throttle by status even when the message borrows pruned text and the status is nested', async () => {
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, 100_000);
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) {
        const e: any = new Error('missing trie node'); // upstream node text, no rate-limit words
        e.status = 429; // managed-RPC throttle — read via errorStatus through the wrapper's cause
        throw e;
      }
      return '0x6000';
    });
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(/missing trie node/);
    expect(queryFilter.calls).toEqual([]); // NOT degraded into a sweep that worsens the throttle
  });

  it('detects a STRING-serialized throttle status ("429") via errorStatus coercion (#1111 review)', async () => {
    const queryFilter = recorder(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, 100_000);
    // Some wrapped RPC/fetch errors serialize the HTTP status as a digit string;
    // errorStatus must coerce "429" so the throttle is still classified (single
    // backend → throttled → nothing left to scan → surfaced).
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) {
        const e: any = new Error('upstream error');
        e.info = { error: { status: '429' } }; // string status, nested
        throw e;
      }
      return '0x6000';
    });
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow();
    expect(queryFilter.calls).toEqual([]); // classified as a throttle (not degraded)
  });

  // Pruned/archive/plan getCode denials → degrade to the genesis scan: eth_getLogs
  // does not need archive state, so the scan still computes the high-water mark on a
  // non-archive provider. Includes geth/erigon pruned phrasings AND managed-RPC
  // archive-on-plan denials (which a publish must NOT fail on).
  const degrades = [
    'this historical request requires an archive node', // pruned/archive
    'block 50 is older than the latest 128 blocks', // geth/erigon pruned window
    'this request requires an archive node, which is not available on your current plan', // archive-on-plan
    'historical state access not enabled on your current tier', // plan denial borrowing "historical state"
    'method eth_getCode is not allowed on this plan', // plan gating on getCode (logs still serve)
    'missing trie node: free plan does not include archival data', // paywall borrowing pruned text
    'please upgrade to Archive tier for this request', // billing CTA for archive
  ];
  for (const message of degrades) {
    it(`degrades to a genesis scan on the non-archive/historical-state error: "${message}"`, async () => {
      const queryFilter = recorder(async () => []);
      const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
      const a = makeAdapter(storage, 100_000);
      (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
        if (block !== undefined) throw new Error(message);
        return '0x6000';
      });
      expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
      expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(0); // anchored at genesis
    });
  }

  it('surfaces a TOTAL auth failure via the scan (not a silent -1n) when getCode AND eth_getLogs are denied (#1111 review)', async () => {
    // A hard auth failure (bad key) affects every method, so getCode degrades to the
    // scan — and the scan then surfaces the 401 on page 1 rather than masking it as
    // a -1n high-water mark. (A static archive/plan denial that ONLY gates getCode
    // would instead return the real max from the still-servable logs — degrade set.)
    const queryFilter = recorder(async () => {
      throw new Error('401 Unauthorized: invalid api key');
    });
    const storage: any = { filters: { KnowledgeAssetCreated: recorder(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, 100_000);
    (a as any).provider.getCode = recorder(async (_addr: string, block?: number) => {
      if (block !== undefined) throw new Error('401 Unauthorized: invalid api key');
      return '0x6000';
    });
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('401 Unauthorized'); // surfaced by the scan
    expect(queryFilter.calls.length).toBeGreaterThan(0); // reached the scan (page 1), not pre-thrown
  });

  // A throttled getCode backend must NOT abort the publish when another reachable
  // backend can still serve the log scan — regardless of order (guards against
  // order-dependence). The throttled backend is dropped from the scan providers
  // (re-querying it would worsen the throttle); the pruned-but-serving sibling
  // (pruned nodes still serve eth_getLogs) computes the real high-water mark.
  for (const prunedFirst of [true, false]) {
    it(`drops a throttled backend and computes the answer via a serving sibling (pruned ${prunedFirst ? 'first' : 'second'}) (#1111 review)`, async () => {
      const head = 100_000;
      const queryFilter = recorder(async () => [{ args: { id: pack(5n) } }]); // an old KA exists, served by the sibling
      const storage: any = {
        target: '0x2222222222222222222222222222222222222222',
        filters: { KnowledgeAssetCreated: recorder(() => 'F') },
        queryFilter,
      };
      const a = makeAdapter(storage, 0);
      const prunedBackend = {
        getBlockNumber: recorder(async () => head),
        getCode: recorder(async (_addr: string, block?: number) => {
          if (block !== undefined) throw new Error('missing trie node');
          return '0x6000';
        }),
      };
      const throttledBackend = {
        getBlockNumber: recorder(async () => head),
        getCode: recorder(async (_addr: string, block?: number) => {
          if (block !== undefined) throw new Error('429 too many requests');
          return '0x6000';
        }),
      };
      (a as any).providers = prunedFirst ? [prunedBackend, throttledBackend] : [throttledBackend, prunedBackend];
      expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n); // computed via the serving sibling, NOT aborted on the 429
      expect(queryFilter.calls.length).toBeGreaterThan(0); // the scan ran (on the non-throttled backend)
    });
  }

  it('scans over the resolving backend head (no empty-range skip when this.provider lags below the deploy block)', async () => {
    const deployBlock = 12_000;
    const backendHead = 20_000;
    const queryFilter = recorder(async () => [{ args: { id: pack(3n) } }]); // an old KA exists
    const storage: any = {
      target: '0x2222222222222222222222222222222222222222',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 5_000); // this.provider lags BELOW deploy — under a separate head read this would skip the scan
    const backend = {
      getBlockNumber: recorder(async () => backendHead),
      getCode: recorder(async (_addr: string, block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x')),
    };
    (a as any).providers = [backend];

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(3n); // scan ran (range from the resolving backend), found the KA
    const [, lo, hi] = queryFilter.calls[0] as unknown as [unknown, number, number];
    expect(lo).toBe(deployBlock);
    expect(hi).toBeGreaterThanOrEqual(deployBlock); // consistent [fromBlock, head] from one backend
  });

  it('degrades to genesis when an unreachable backend fails head-probe but a reachable backend is merely pruned', async () => {
    const head = 100_000;
    const queryFilter = recorder(async () => []);
    const storage: any = {
      target: '0x2222222222222222222222222222222222222222',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 0);
    // backend 0: completely down — getBlockNumber AND getCode fail (a real,
    // non-historical error). R1: the standalone bytecode probe now consults
    // getCode via readProvider, so a down node must THROW (not return
    // undefined, which would be read as a valid empty result and short-circuit
    // before failover to the pruned-but-reachable backend).
    const downBackend = {
      getBlockNumber: recorder(async () => { throw new Error('503 node is down'); }),
      getCode: recorder(async () => { throw new Error('503 node is down'); }),
    };
    // backend 1: reachable but pruned — historical getCode unavailable
    const prunedBackend = {
      getBlockNumber: recorder(async () => head),
      getCode: recorder(async (_addr: string, block?: number) => {
        if (block !== undefined) throw new Error('missing trie node');
        return '0x6000';
      }),
    };
    (a as any).providers = [downBackend, prunedBackend];

    // The down backend's head-probe error must NOT force a throw — a reachable
    // (pruned) backend exists, so we degrade to the genesis scan.
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    expect((queryFilter.calls[0] as unknown as [unknown, number, number])[1]).toBe(0);
  });

  it('fails over the log scan to a capable secondary backend when the freshest one errors on queryFilter (#1111 review)', async () => {
    const deployBlock = 12_000;
    const head = 20_000;
    const storage: any = {
      target: '0x2222222222222222222222222222222222222222',
      filters: { KnowledgeAssetCreated: recorder(() => 'F') },
    };
    const code = (block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x');
    // Both backends at the same (freshest) head, so both COVER every page. The
    // freshest errors on queryFilter; the scan must fail over to the secondary.
    const freshestQF = recorder(async () => {
      throw new Error('eth_getLogs is not available on this endpoint');
    });
    const secondaryQF = recorder(async () => [{ args: { id: pack(4n) } }]);
    const b0 = { getBlockNumber: recorder(async () => head), getCode: recorder(async (_a: string, block?: number) => code(block)), qf: freshestQF };
    const b1 = { getBlockNumber: recorder(async () => head), getCode: recorder(async (_a: string, block?: number) => code(block)), qf: secondaryQF };
    const a = makeAdapter(storage, 0);
    (storage as any).connect = (p: any) => ({ filters: storage.filters, queryFilter: p.qf });
    (a as any).providers = [b0, b1];

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(4n); // failed over to b1 and found the KA
    expect(freshestQF.calls.length).toBeGreaterThan(0); // freshest tried first (errored)
    expect(secondaryQF.calls.length).toBeGreaterThan(0); // failed over to the capable secondary
  });

  it('times out a HUNG freshest backend per page, fails over, then sticks to the server for later pages (#1111 review)', async () => {
    vi.useFakeTimers();
    try {
      const deployBlock = 12_000;
      const head = 14_500; // [12000,13999] + [14000,14500] = two 2000-block pages
      const storage: any = {
        target: '0x3333333333333333333333333333333333333333',
        filters: { KnowledgeAssetCreated: recorder(() => 'F') },
      };
      const code = (block?: number) => (block === undefined || block >= deployBlock ? '0x6000' : '0x');
      // Both backends at the same (freshest) head, so both COVER every page. The
      // freshest HANGS on queryFilter (never settles); the per-page timeout must
      // fire and fail over to the secondary, and the sticky-preferred ordering
      // must keep the hung backend off the front of the line for page 2 (so its
      // timeout is paid ONCE, not once per page).
      const freshestQF = recorder(() => new Promise<never>(() => {})); // never resolves
      const secondaryQF = recorder(async () => [{ args: { id: pack(6n) } }]);
      const b0 = { getBlockNumber: recorder(async () => head), getCode: recorder(async (_a: string, block?: number) => code(block)), qf: freshestQF };
      const b1 = { getBlockNumber: recorder(async () => head), getCode: recorder(async (_a: string, block?: number) => code(block)), qf: secondaryQF };
      const a = makeAdapter(storage, 0);
      (storage as any).connect = (p: any) => ({ filters: storage.filters, queryFilter: p.qf });
      (a as any).providers = [b0, b1];

      let settled = false;
      const resultP = a.getMaxKaNumberForAuthor(AUTHOR).then((v) => {
        settled = true;
        return v;
      });
      // Before the 15s page timeout elapses, b0 is still "hanging" and the scan has
      // NOT failed over — proving the wait is genuinely bounded by the timeout (not
      // some unrelated synchronous failover). (15s = KA_HIGH_WATER_PAGE_TIMEOUT_MS.)
      await vi.advanceTimersByTimeAsync(14_000);
      expect(settled).toBe(false);
      expect(secondaryQF.calls).toEqual([]);
      // Cross the timeout boundary: page 1 times out → fails over to b1; page 2 then
      // runs on the sticky preferred b1 with no timer, completing the scan.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await resultP).toBe(6n);

      // b0 paid its timeout exactly ONCE (page 1); page 2 went straight to b1.
      expect(freshestQF.calls).toHaveLength(1);
      expect(secondaryQF.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
