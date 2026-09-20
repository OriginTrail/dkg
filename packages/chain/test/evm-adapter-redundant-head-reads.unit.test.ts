/**
 * Redundant chain-head reads removed from two hot paths — with ZERO staleness.
 *
 *  1. Deploy-block resolution. `resolveContractDeployBlock` probes `eth_blockNumber` on every
 *     backend BEFORE it consults the immutable deploy-block cache. The authority index/snapshot
 *     callers keep only `fromBlock`, so that probe bought nothing on every scan.
 *     `resolveContractDeployBlockNumber` answers a cache hit with no request; a miss — and the
 *     uncached degraded `0` — still probes and searches exactly as before.
 *
 *  2. Receipt finality. At `finalityConfirmations == 1` the required head IS the receipt block, so
 *     the same-provider block-hash read already proves it; the extra `eth_blockNumber` per mined
 *     tx is gone. Depths > 1 still read the head. The header that read fetched is remembered BY
 *     HASH (never by number) so the receipt parser's timestamp read of the same block is free.
 *
 * The code under test is REAL (`EVMChainAdapter` + its production failover client); only the
 * providers are hand-rolled recorders, the same DI seam the sibling adapter unit tests use.
 */
import { describe, it, expect } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const CONTRACT = '0x00000000000000000000000000000000000000AA';
// Same address, different letter case from both CONTRACT and its lowercase form.
const MIXED_CASE_CONTRACT = '0x00000000000000000000000000000000000000aA';
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const OTHER_HASH = `0x${'99'.repeat(32)}`;
const RECEIPT = { blockNumber: 123, blockHash: BLOCK_HASH };

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

function makeAdapter(providers: unknown[], overrides: Partial<EVMAdapterConfig> = {}) {
  const a: any = new EVMChainAdapter(minimalConfig(overrides));
  a.initialized = true;
  a.init = async () => { a.initialized = true; };
  a.ensureConfiguredStaticChainIdValidated = async () => 31337n;
  a.providers = providers;
  a.rpcUrls = providers.map((_, index) => `https://endpoint-${index}.example`);
  return a;
}

describe('resolveContractDeployBlockNumber: the immutable deploy block needs no head probe', () => {
  const HEAD = 100_000;
  const DEPLOY_BLOCK = 90_000;

  function archiveProvider() {
    return {
      getBlockNumber: recorder(async () => HEAD),
      getCode: recorder(async (_address: string, block?: number) => (
        block === undefined || block >= DEPLOY_BLOCK ? '0x6000' : '0x'
      )),
    };
  }

  it('a miss probes + binary-searches once; every later call issues NO request at all', async () => {
    const primary = archiveProvider();
    const backup = archiveProvider();
    const a = makeAdapter([primary, backup]);

    // Warm with the LOWERCASE form, then look up with a checksummed (mixed-case) one below:
    // the cache key is the lowercase address, so a lookup that skipped the normalisation
    // would miss and probe again.
    expect(await a.resolveContractDeployBlockNumber(CONTRACT.toLowerCase(), 'unit', 'Contract')).toBe(DEPLOY_BLOCK);
    // The miss is today's resolution, unchanged: every backend is head-probed, one is searched.
    expect(primary.getBlockNumber.calls).toHaveLength(1);
    expect(backup.getBlockNumber.calls).toHaveLength(1);
    const searchReads = primary.getCode.calls.length;
    expect(searchReads).toBeGreaterThan(1);

    for (let i = 0; i < 5; i += 1) {
      expect(await a.resolveContractDeployBlockNumber(MIXED_CASE_CONTRACT, 'unit', 'Contract'))
        .toBe(DEPLOY_BLOCK);
    }
    expect(primary.getBlockNumber.calls).toHaveLength(1);
    expect(backup.getBlockNumber.calls).toHaveLength(1);
    expect(primary.getCode.calls).toHaveLength(searchReads);
    expect(backup.getCode.calls).toHaveLength(0);
  });

  it('callers that consume head/scanProviders still probe every backend on a cache hit', async () => {
    const primary = archiveProvider();
    const backup = { ...archiveProvider(), getBlockNumber: recorder(async () => HEAD + 5) };
    const a = makeAdapter([primary, backup]);
    await a.resolveContractDeployBlockNumber(CONTRACT, 'unit', 'Contract');
    const probesAfterWarmup = primary.getBlockNumber.calls.length;

    const resolved = await a.resolveContractDeployBlock(CONTRACT, 'unit', 'Contract');

    expect(resolved.fromBlock).toBe(DEPLOY_BLOCK);
    expect(resolved.head).toBe(HEAD + 5); // a LIVE head, freshest backend first
    expect(resolved.scanProviders.map((entry: { provider: unknown }) => entry.provider))
      .toEqual([backup, primary]);
    expect(primary.getBlockNumber.calls).toHaveLength(probesAfterWarmup + 1);
  });

  it('the degraded block-0 anchor stays UNCACHED: the next call probes and searches again', async () => {
    // Pruned / non-archive backend: latest code is served, historical getCode is not.
    const pruned = {
      getBlockNumber: recorder(async () => HEAD),
      getCode: recorder(async (_address: string, block?: number) => {
        if (block !== undefined) throw new Error('missing trie node (pruned node)');
        return '0x6000';
      }),
    };
    const a = makeAdapter([pruned]);

    expect(await a.resolveContractDeployBlockNumber(CONTRACT, 'unit', 'Contract')).toBe(0);
    expect(a.cachedContractDeployBlocks.get(CONTRACT.toLowerCase())).toBeUndefined();
    const probes = pruned.getBlockNumber.calls.length;
    const searches = pruned.getCode.calls.length;
    expect(probes).toBe(1);
    expect(searches).toBeGreaterThan(0);

    expect(await a.resolveContractDeployBlockNumber(CONTRACT, 'unit', 'Contract')).toBe(0);
    expect(pruned.getBlockNumber.calls).toHaveLength(probes + 1);
    expect(pruned.getCode.calls.length).toBeGreaterThan(searches);
  });

  it('invalidatePublishPreflightCache drops the cached deploy block, so the next call re-resolves', async () => {
    const primary = archiveProvider();
    const a = makeAdapter([primary]);
    await a.resolveContractDeployBlockNumber(CONTRACT, 'unit', 'Contract');
    a.invalidatePublishPreflightCache();
    a.ensureConfiguredStaticChainIdValidated = async () => 31337n;

    expect(await a.resolveContractDeployBlockNumber(CONTRACT, 'unit', 'Contract')).toBe(DEPLOY_BLOCK);
    expect(primary.getBlockNumber.calls).toHaveLength(2);
  });
});

describe('isReceiptBlockFinalAndCanonical: one block read decides at depth 1', () => {
  function endpoint(script: {
    head: number;
    atHeight: { number: number; hash: string; timestamp?: number } | null;
  }) {
    return {
      getBlockNumber: recorder(async () => script.head),
      getBlock: recorder(async (_tag: number | string) => script.atHeight),
    };
  }

  function blockErrorEndpoint(head: number, message = 'header not found') {
    return {
      getBlockNumber: recorder(async () => head),
      getBlock: recorder(async () => {
        const error = new Error(message);
        Object.assign(error, { code: 'CALL_EXCEPTION' });
        throw error;
      }),
    };
  }

  it('depth 1: exactly ONE getBlock(receipt height) and ZERO head reads for a canonical receipt', async () => {
    const p = endpoint({ head: 123, atHeight: { number: 123, hash: BLOCK_HASH, timestamp: 1_700 } });
    const a = makeAdapter([p]);

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);

    expect(p.getBlockNumber.calls).toHaveLength(0);
    expect(p.getBlock.calls).toEqual([[123]]);
  });

  it('depth 1: canonicality is still enforced — a different hash at the height answers false', async () => {
    const p = endpoint({ head: 200, atHeight: { number: 123, hash: OTHER_HASH, timestamp: 1_700 } });
    const a = makeAdapter([p]);

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
    expect(p.getBlockNumber.calls).toHaveLength(0);
  });

  it('depth 1: an endpoint that has not reached the receipt block yields to one that has', async () => {
    // What the dropped head comparison used to catch: a lagging endpoint has no block at the
    // height, answers null, and the walk moves on — never a `false` verdict from absence.
    const lagging = endpoint({ head: 122, atHeight: null });
    const healthy = endpoint({ head: 123, atHeight: { number: 123, hash: BLOCK_HASH } });
    const a = makeAdapter([lagging, healthy]);

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(lagging.getBlock.calls).toHaveLength(1);
    expect(healthy.getBlock.calls).toHaveLength(1);
    expect(lagging.getBlockNumber.calls).toHaveLength(0);
    expect(healthy.getBlockNumber.calls).toHaveLength(0);
  });

  it('depth 1: a confirmed above-head block error yields to a sibling', async () => {
    const lagging = blockErrorEndpoint(122);
    const healthy = endpoint({ head: 123, atHeight: { number: 123, hash: BLOCK_HASH } });
    const a = makeAdapter([lagging, healthy]);

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(lagging.getBlock.calls).toEqual([[123]]);
    expect(healthy.getBlock.calls).toEqual([[123]]);
    expect(lagging.getBlockNumber.calls).toHaveLength(1);
    expect(healthy.getBlockNumber.calls).toHaveLength(0);
  });

  it('depth 1: a bare block error surfaces when the endpoint has reached the receipt height', async () => {
    const unhealthy = blockErrorEndpoint(123);
    const a = makeAdapter([unhealthy]);

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT))
      .rejects.toThrow('header not found');
    expect(unhealthy.getBlock.calls).toEqual([[123]]);
    expect(unhealthy.getBlockNumber.calls).toHaveLength(1);
  });

  it('depth 1: all above-head error responses exhaust as a false verdict', async () => {
    const first = blockErrorEndpoint(121, 'unknown block');
    const second = blockErrorEndpoint(122, 'block not found');
    const a = makeAdapter([first, second]);

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
    expect(first.getBlock.calls).toEqual([[123]]);
    expect(second.getBlock.calls).toEqual([[123]]);
    expect(first.getBlockNumber.calls).toHaveLength(1);
    expect(second.getBlockNumber.calls).toHaveLength(1);
  });

  it('depth 1: above-head error, null, then canonical block keeps walking siblings', async () => {
    const erroring = blockErrorEndpoint(121);
    const empty = endpoint({ head: 122, atHeight: null });
    const healthy = endpoint({ head: 123, atHeight: { number: 123, hash: BLOCK_HASH } });
    const a = makeAdapter([erroring, empty, healthy]);

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(erroring.getBlock.calls).toHaveLength(1);
    expect(empty.getBlock.calls).toHaveLength(1);
    expect(healthy.getBlock.calls).toHaveLength(1);
  });

  it('depth 1: false (not true) when NO endpoint serves the receipt height', async () => {
    const a = makeAdapter([endpoint({ head: 200, atHeight: null }), endpoint({ head: 200, atHeight: null })]);
    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
  });

  it('depth 3: the head read remains the proof — not eligible until head >= n + 2', async () => {
    const shallow = endpoint({ head: 124, atHeight: { number: 123, hash: BLOCK_HASH } });
    const a = makeAdapter([shallow], { finalityConfirmations: 3 });

    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
    expect(shallow.getBlockNumber.calls).toHaveLength(1);
    expect(shallow.getBlock.calls).toHaveLength(0); // depth gate closes before the hash read

    const deep = endpoint({ head: 125, atHeight: { number: 123, hash: BLOCK_HASH } });
    const b = makeAdapter([deep], { finalityConfirmations: 3 });
    await expect(b.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(deep.getBlockNumber.calls).toHaveLength(1);
    expect(deep.getBlock.calls).toEqual([[123]]);
  });
});

describe('getBlockTimestamp reuses the finality check\'s header — by HASH only', () => {
  function endpoint(atHeight: { number: number; hash: string; timestamp: number } | null) {
    return {
      getBlockNumber: recorder(async () => 500),
      getBlock: recorder(async (_tag: number | string) => atHeight),
    };
  }

  it('after the finality check, the receipt block timestamp costs no request', async () => {
    const p = endpoint({ number: 123, hash: BLOCK_HASH, timestamp: 1_700_000_123 });
    const a = makeAdapter([p]);
    await a.isReceiptBlockFinalAndCanonical(RECEIPT);
    expect(p.getBlock.calls).toHaveLength(1);

    // Hash casing differs between RPC payloads and receipts; the key is case-insensitive.
    expect(await a.getBlockTimestamp(123, { blockHash: BLOCK_HASH.toUpperCase().replace('0X', '0x') }))
      .toBe(1_700_000_123);
    expect(p.getBlock.calls).toHaveLength(1); // per tx: finality + timestamp = ONE block read
  });

  it('an already-aborted caller rejects even when the timestamp memo has the answer', async () => {
    const p = endpoint({ number: 123, hash: BLOCK_HASH, timestamp: 1_700_000_123 });
    const a = makeAdapter([p]);
    await a.isReceiptBlockFinalAndCanonical(RECEIPT);
    const controller = new AbortController();
    const reason = new Error('cancelled before timestamp lookup');
    controller.abort(reason);

    await expect(a.getBlockTimestamp(123, {
      blockHash: BLOCK_HASH,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(p.getBlock.calls).toHaveLength(1);
  });

  it('without a block hash the by-number read still goes to the wire', async () => {
    const p = endpoint({ number: 123, hash: BLOCK_HASH, timestamp: 1_700_000_123 });
    const a = makeAdapter([p]);
    await a.isReceiptBlockFinalAndCanonical(RECEIPT);

    expect(await a.getBlockTimestamp(123)).toBe(1_700_000_123);
    expect(p.getBlock.calls).toHaveLength(2);
  });

  it('a mismatched block number and hash cannot hit the remembered header', async () => {
    const p = {
      getBlockNumber: recorder(async () => 500),
      getBlock: recorder(async (tag: number | string) => tag === 999
        ? { number: 999, hash: OTHER_HASH, timestamp: 1_700_000_999 }
        : { number: 123, hash: BLOCK_HASH, timestamp: 1_700_000_123 }),
    };
    const a = makeAdapter([p]);
    await a.isReceiptBlockFinalAndCanonical(RECEIPT);
    expect(p.getBlock.calls).toHaveLength(1);

    expect(await a.getBlockTimestamp(999, { blockHash: BLOCK_HASH })).toBe(1_700_000_999);
    expect(p.getBlock.calls).toHaveLength(2);
    expect(p.getBlock.calls[1]?.[0]).toBe(999);
  });

  it('a DIFFERENT hash at the same height is a miss: the reorged-in header is never served', async () => {
    // The chain now holds OTHER_HASH at height 123 (the receipt's block was reorged out). The
    // finality check answers false and remembers the header under ITS OWN hash, so a lookup by
    // the receipt's hash must miss and re-read — and a lookup by the new hash is served.
    const p = endpoint({ number: 123, hash: OTHER_HASH, timestamp: 42 });
    const a = makeAdapter([p]);
    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
    expect(p.getBlock.calls).toHaveLength(1);

    await a.getBlockTimestamp(123, { blockHash: BLOCK_HASH });
    expect(p.getBlock.calls).toHaveLength(2);

    expect(await a.getBlockTimestamp(123, { blockHash: OTHER_HASH })).toBe(42);
    expect(p.getBlock.calls).toHaveLength(2);
  });

  it('stores a timestamp-less header but does not reuse it for a timestamp read', async () => {
    const p = {
      getBlockNumber: recorder(async () => 500),
      getBlock: recorder(async (_tag: number | string) => ({ number: 123, hash: BLOCK_HASH })),
    };
    const a = makeAdapter([p]);
    await expect(a.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(a.receiptBlockHeadersByHash.size).toBe(1);
    expect(a.receiptBlockHeadersByHash.get(BLOCK_HASH)).toEqual({
      number: 123,
      hash: BLOCK_HASH,
    });

    expect(await a.getBlockTimestamp(123, { blockHash: BLOCK_HASH })).toBe(0); // today's best-effort
    expect(p.getBlock.calls).toHaveLength(2);
  });

  it('a miss keeps the null-block failover: the backup serves the timestamp, not a bogus 0', async () => {
    const lagging = endpoint(null);
    const healthy = endpoint({ number: 123, hash: BLOCK_HASH, timestamp: 77 });
    const a = makeAdapter([lagging, healthy]);

    expect(await a.getBlockTimestamp(123, { blockHash: BLOCK_HASH })).toBe(77);
    expect(lagging.getBlock.calls).toHaveLength(1);
    expect(healthy.getBlock.calls).toHaveLength(1);
  });

  it('invalidatePublishPreflightCache (devnet reset / test isolation) empties the memo', async () => {
    const p = endpoint({ number: 123, hash: BLOCK_HASH, timestamp: 9 });
    const a = makeAdapter([p]);
    await a.isReceiptBlockFinalAndCanonical(RECEIPT);
    a.invalidatePublishPreflightCache();
    a.ensureConfiguredStaticChainIdValidated = async () => 31337n;

    await a.getBlockTimestamp(123, { blockHash: BLOCK_HASH });
    expect(p.getBlock.calls).toHaveLength(2);
  });

  it('the memo is bounded: the oldest header is evicted, and an evicted entry just re-reads', async () => {
    let served = 0;
    const p = {
      getBlockNumber: recorder(async () => 10_000),
      getBlock: recorder(async (tag: number | string) => {
        served += 1;
        return { number: Number(tag), hash: `0x${Number(tag).toString(16).padStart(64, '0')}`, timestamp: Number(tag) };
      }),
    };
    const a = makeAdapter([p]);
    const hashOf = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    for (let n = 1; n <= 257; n += 1) {
      await a.isReceiptBlockFinalAndCanonical({ blockNumber: n, blockHash: hashOf(n) });
    }
    expect(a.receiptBlockHeadersByHash.size).toBe(256);
    const before = served;

    expect(await a.getBlockTimestamp(257, { blockHash: hashOf(257) })).toBe(257); // newest: served
    expect(served).toBe(before);
    expect(await a.getBlockTimestamp(1, { blockHash: hashOf(1) })).toBe(1); // evicted: re-read
    expect(served).toBe(before + 1);
  });
});
