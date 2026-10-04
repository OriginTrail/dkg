import { describe, expect, it, vi } from 'vitest';
import { assertCanonicalGraphScopedAuthorSealV1 } from '@origintrail-official/dkg-core';
import type { ChainAdapter, KnowledgeAssetVersionSnapshot } from '@origintrail-official/dkg-chain';
import { readConfirmedDraftVersion } from '../src/confirmed-draft-version.js';
import { assertRfc64CatalogReplacementOrderV1 } from '../src/rfc64/catalog-replacement-order-v1.js';

const AUTHOR = `0x${'11'.repeat(20)}`;
const OTHER = `0x${'22'.repeat(20)}`;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;

function asset(version = '4', finalizedAt = '2026-07-19T12:34:56.789Z') {
  const seal = {
    assertionMerkleRoot: `0x${'33'.repeat(32)}`, authorAddress: AUTHOR,
    authorAttestationR: `0x${'44'.repeat(32)}`, authorAttestationVS: `0x${'55'.repeat(32)}`,
    authorSchemeVersion: '1', assertedAtChainId: '20430',
    assertedAtKav10Address: `0x${'66'.repeat(20)}`, reservedKaId: KA_ID.toString(),
    assertionFinalizedAt: finalizedAt, contentScopeVersion: '2', kaUal: UAL,
    assertionVersion: version, publicTripleCount: '1', privateTripleCount: '0', privateMerkleRoot: null,
  };
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return { assertionCoordinate: 'chain-evidence' as never, seal, projectionBytes: new Uint8Array([1]) };
}

function snapshot(overrides: Partial<KnowledgeAssetVersionSnapshot> = {}): KnowledgeAssetVersionSnapshot {
  return {
    knowledgeAssetId: KA_ID, rootCount: 1n, latestRoot: `0x${'33'.repeat(32)}`,
    latestAuthor: AUTHOR, latestPublisher: OTHER, blockNumber: 42,
    blockHash: `0x${'77'.repeat(32)}`, ...overrides,
  };
}

function adapter(value: KnowledgeAssetVersionSnapshot | null = snapshot(), current = true) {
  const read = vi.fn(async () => value);
  const currency = vi.fn(async () => current);
  const independentRead = vi.fn(() => { throw new Error('must not compose separate chain views'); });
  const chain = {
    chainId: 'otp:20430', chainType: 'evm',
    readKnowledgeAssetVersionSnapshot: read, knowledgeAssetVersionSnapshotIsCurrent: currency,
    getKnowledgeAssetRootCount: independentRead, getKnowledgeAssetLatestAuthor: independentRead,
  } as unknown as ChainAdapter;
  return { chain, read, currency, independentRead };
}

const currentAsset = asset();
const replacement = asset('4', '2026-07-19T12:34:57.789Z');
const callers = ['confirmed draft', 'RFC-64 replacement'] as const;
async function call(lane: typeof callers[number], chain: ChainAdapter, signal?: AbortSignal) {
  if (lane === 'confirmed draft') return readConfirmedDraftVersion(chain, UAL, signal ? { signal } : undefined);
  return assertRfc64CatalogReplacementOrderV1(chain, [currentAsset], [replacement], signal);
}

describe.each(callers)('%s coherent chain evidence', lane => {
  it.each([
    { name: 'unavailable', value: null, current: true, stale: false },
    { name: 'negative count', value: snapshot({ rootCount: -1n }), current: true, stale: false },
    { name: 'another KA identity', value: snapshot({ knowledgeAssetId: KA_ID + 1n }), current: true, stale: false },
    { name: 'another author', value: snapshot({ latestAuthor: OTHER }), current: true, stale: false },
    { name: 'superseded snapshot', value: snapshot(), current: false, stale: true },
  ])('refuses $name before accepting a draft', async ({ value, current, stale }) => {
    const f = adapter(value, current);
    const result = call(lane, f.chain);
    if (lane === 'confirmed draft') await expect(result).resolves.toBeNull();
    else await expect(result).rejects.toThrow(stale ? 'chain snapshot is no longer current' : 'requires coherent proof');
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.currency).toHaveBeenCalledTimes(stale ? 1 : 0);
    expect(f.independentRead).not.toHaveBeenCalled();
  });

  it('refuses adapters without coherent evidence instead of falling back to independent reads', async () => {
    if (lane === 'confirmed draft') await expect(call(lane, { chainId: 'otp:20430', chainType: 'evm' } as ChainAdapter)).resolves.toBeNull();
    else await expect(call(lane, { chainId: 'otp:20430', chainType: 'evm' } as ChainAdapter)).rejects.toThrow('requires coherent proof');
  });

  it.each(['base:8453', 'none', 'otp:020430', 'otp:0', undefined])('refuses an unbound adapter %s before any RPC', async chainId => {
    const f = adapter(snapshot({ rootCount: 0n }));
    Object.assign(f.chain, { chainId });
    const result = call(lane, f.chain);
    if (lane === 'confirmed draft') await expect(result).resolves.toBeNull();
    else await expect(result).rejects.toThrow('requires coherent proof');
    expect(f.read).not.toHaveBeenCalled(); expect(f.currency).not.toHaveBeenCalled();
  });

  it.each(['20430', 'evm:20430', 'otp:20430'])('accepts the supported numeric network alias %s', async chainId => {
    const f = adapter(); Object.assign(f.chain, { chainId });
    const result = call(lane, f.chain);
    if (lane === 'confirmed draft') await expect(result).resolves.toBe(1n);
    else await expect(result).resolves.toBeUndefined();
    expect(f.read).toHaveBeenCalledOnce(); expect(f.currency).toHaveBeenCalledOnce();
  });

  it('accepts one matching view and forwards cancellation through its currency fence', async () => {
    const f = adapter(snapshot({ latestAuthor: AUTHOR.toUpperCase() }));
    const signal = new AbortController().signal;
    const result = call(lane, f.chain, signal);
    if (lane === 'confirmed draft') await expect(result).resolves.toBe(1n);
    else await expect(result).resolves.toBeUndefined();
    expect(f.read).toHaveBeenCalledExactlyOnceWith(KA_ID, { signal });
    expect(f.currency).toHaveBeenCalledExactlyOnceWith(KA_ID, expect.objectContaining({ rootCount: 1n }), { signal });
    expect(f.independentRead).not.toHaveBeenCalled();
  });

  it.each(['snapshot read', 'currency read'] as const)('preserves cancellation during the %s', async phase => {
    const f = adapter();
    const controller = new AbortController();
    const reason = new Error(`cancelled during ${phase}`);
    if (phase === 'snapshot read') f.read.mockImplementationOnce(async () => { controller.abort(reason); return snapshot(); });
    else f.currency.mockImplementationOnce(async () => { controller.abort(reason); return true; });
    await expect(call(lane, f.chain, controller.signal)).rejects.toBe(reason);
    expect(f.currency).toHaveBeenCalledTimes(phase === 'snapshot read' ? 0 : 1);
  });

  it.each(['snapshot read', 'currency read'] as const)('refuses a chain binding that changes during the %s', async phase => {
    const f = adapter();
    if (phase === 'snapshot read') f.read.mockImplementationOnce(async () => { Object.assign(f.chain, { chainId: 'base:8453' }); return snapshot(); });
    else f.currency.mockImplementationOnce(async () => { Object.assign(f.chain, { chainId: 'base:8453' }); return true; });
    const result = call(lane, f.chain);
    if (lane === 'confirmed draft') await expect(result).resolves.toBeNull();
    else await expect(result).rejects.toThrow('requires coherent proof');
    expect(f.currency).toHaveBeenCalledTimes(phase === 'snapshot read' ? 0 : 1);
  });

  it('propagates a failed coherent read without acquiring a substitute view', async () => {
    const f = adapter();
    const error = new Error('RPC unavailable');
    f.read.mockRejectedValueOnce(error);
    await expect(call(lane, f.chain)).rejects.toBe(error);
    expect(f.currency).not.toHaveBeenCalled();
    expect(f.independentRead).not.toHaveBeenCalled();
  });
});

it('keeps the RFC-64 lower-version restriction separate from zero-root evidence', async () => {
  const f = adapter(snapshot({ rootCount: 0n, latestAuthor: OTHER }));
  await expect(readConfirmedDraftVersion(f.chain, UAL)).resolves.toBe(0n);
  f.currency.mockClear();
  await expect(assertRfc64CatalogReplacementOrderV1(f.chain, [currentAsset], [
    asset('2', '2026-07-19T12:34:57.789Z'),
  ])).rejects.toThrow('requires coherent proof');
  expect(f.currency).not.toHaveBeenCalled();
});

it('accepts a higher sealed version without requiring unpublished-number evidence', async () => {
  const f = adapter(null);
  await expect(assertRfc64CatalogReplacementOrderV1(f.chain, [currentAsset], [
    asset('5', '2026-07-19T12:34:57.789Z'),
  ])).resolves.toBeUndefined();
  expect(f.read).not.toHaveBeenCalled();
});
