// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { ContextGraphAuthorityIndex as ContextGraphAuthorityIndexBase } from
  '../src/context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexId } from '../src/context-graph-authority-index-id.js';
import type { ContextGraphAuthorityIndexCheckpoint, ContextGraphAuthorityIndexStore } from
  '../src/context-graph-authority-index-checkpoint.js';
import { createContextGraphAuthorityIndexCheckpoint } from
  '../src/context-graph-authority-index-checkpoint.js';
import { reduceContextGraphAuthorityIndexPage } from '../src/context-graph-authority-index-reducer.js';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES,
  CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS,
  ContextGraphAuthorityIndexBootstrapUnavailableError,
  normalizeContextGraphAuthorityIndexSnapshot,
  type ContextGraphAuthorityIndexBootstrap,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from '../src/context-graph-authority-index-snapshot.js';

const SCOPE = 'evm:84532:hub=0x1111:0x2222';
const DEPLOYMENT = 10;
const HEAD = 3_780_010;
const OWNER = `0x${'11'.repeat(20)}`;
const NAME = `0x${'99'.repeat(32)}`;
const hash = (block: number) => `0x${block.toString(16).padStart(64, '0')}`;

/** Bootstrap lifecycle tests select their state explicitly from the canonical view. */
class ContextGraphAuthorityIndex extends ContextGraphAuthorityIndexBase {
  async resolve(
    input: Parameters<ContextGraphAuthorityIndexBase['view']>[0]
      & { readonly contextGraphId: ContextGraphAuthorityIndexId },
  ) {
    return (await this.view(input)).resolve(input.contextGraphId);
  }
}

class ScopedStore implements ContextGraphAuthorityIndexStore {
  readonly records = new Map<string, { token: number; value: unknown | null }>();
  load = vi.fn(async (scope: string) => this.records.get(scope));
  compareAndSwap = vi.fn(async (scope: string, token: number | undefined, value: unknown) => {
    if (this.records.get(scope)?.token !== token) return undefined;
    const next = (token ?? 0) + 1;
    this.records.set(scope, { token: next, value });
    return next;
  });
  invalidate = vi.fn(async (scope: string, token: number) => {
    if (this.records.get(scope)?.token !== token) return undefined;
    this.records.set(scope, { token: token + 1, value: null });
    return token + 1;
  });
}

function checkpoint(throughBlockNumber = HEAD - 100): ContextGraphAuthorityIndexCheckpoint {
  return reduceContextGraphAuthorityIndexPage({
    deploymentBlockNumber: DEPLOYMENT,
    throughBlockNumber,
    throughBlockHash: hash(throughBlockNumber),
    events: [{
      name: 'ContextGraphCreated', contextGraphId: 9n,
      blockNumber: DEPLOYMENT, blockHash: hash(DEPLOYMENT), index: 0,
      owner: OWNER, nameHash: NAME, participantAgents: [OWNER],
      accessPolicy: 1, publishPolicy: 0,
      publishAuthority: OWNER, publishAuthorityAccountId: 0n,
    }],
  }).checkpoint;
}

const envelope = (value = checkpoint()) => ({ version: 1, scope: SCOPE, checkpoint: value });
const request = (): ContextGraphAuthorityIndexSnapshotRequest => ({
  scope: SCOPE, deploymentBlockNumber: DEPLOYMENT,
  minThroughBlockNumber: HEAD - 200, maxThroughBlockNumber: HEAD - 50,
});
const input = (readPage = vi.fn(async (_from: number, _to: number) => [])) => ({
  scope: SCOPE, readScope: {}, contextGraphId: '9' as ContextGraphAuthorityIndexId,
  deploymentBlockNumber: DEPLOYMENT, finalized: { number: HEAD, hash: hash(HEAD) },
  durableReorgHoldbackBlocks: 50, pageSize: 2_000,
  readBlockHash: vi.fn(async (block: number) => hash(block)), readPage,
});
const bootstrap = (overrides: Partial<ContextGraphAuthorityIndexBootstrap> = {}) => ({
  trustDomain: 'trusted-core-A', maxTailBlocks: 200,
  fetchSnapshot: vi.fn(async () => envelope()), ...overrides,
});

describe('trusted core authority index bootstrap', () => {
  it('rejects a tail budget that leaves no refresh or head-skew margin', () => {
    expect(() => new ContextGraphAuthorityIndex(new ScopedStore(), bootstrap({ maxTailBlocks: 50 })))
      .toThrow('bootstrap configuration is invalid');
  });

  it.each([
    { maxTailBlocks: 10_001 },
    { maxTailBlocks: 200.5 },
    { maxTailBlocks: Number.NaN },
    { trustDomain: '' },
    { trustDomain: '   ' },
    { trustDomain: 'x'.repeat(257) },
    { trustDomain: 1 as unknown as string },
    { fetchSnapshot: undefined as unknown as ContextGraphAuthorityIndexBootstrap['fetchSnapshot'] },
  ])('rejects invalid bootstrap construction before store or transport activity: %j', (invalid) => {
    const store = new ScopedStore();
    const source = bootstrap(invalid);
    expect(() => new ContextGraphAuthorityIndex(store, source)).toThrow('bootstrap configuration is invalid');
    expect(store.load).not.toHaveBeenCalled();
    expect(store.compareAndSwap).not.toHaveBeenCalled();
  });

  it('imports a small prefix snapshot and reads only 100 tail blocks across 3.78m historical blocks', async () => {
    const store = new ScopedStore();
    const source = bootstrap();
    const index = new ContextGraphAuthorityIndex(store, source);
    const scan = input();
    const state = await index.resolve(scan);
    expect(state.owner).toBe(OWNER);
    expect(source.fetchSnapshot).toHaveBeenCalledWith(request(), expect.any(AbortSignal), expect.any(Function));
    expect(scan.readPage.mock.calls.map(([from, to]) => [from, to])).toEqual([[HEAD - 99, HEAD - 50], [HEAD - 49, HEAD]]);
    expect(scan.readBlockHash.mock.calls).toEqual([[HEAD - 100, expect.any(AbortSignal)], [HEAD - 50, expect.any(AbortSignal)]]);
    expect(store.records.get(`${SCOPE}:trusted-bootstrap:trusted-core-A`)?.value).toMatchObject({
      cursor: { throughBlockNumber: HEAD - 50 }, states: [{ contextGraphId: '9' }],
    });
    expect(store.records.has(SCOPE)).toBe(false);
    expect(index.exportSnapshot(request())).toBeNull();
  });

  it('uses the same durable trust domain after restart without fetching a new snapshot', async () => {
    const store = new ScopedStore();
    await new ContextGraphAuthorityIndex(store, bootstrap()).resolve(input());
    const fetchSnapshot = vi.fn(async () => { throw new Error('must resume locally'); });
    const scan = input();
    await new ContextGraphAuthorityIndex(store, bootstrap({ fetchSnapshot })).resolve(scan);
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(scan.readPage.mock.calls.map(([from, to]) => [from, to])).toEqual([[HEAD - 49, HEAD]]);
  });

  it('applies roster changes in the local tail even when the final membership matches the seed', async () => {
    const events = [
      { name: 'AgentParticipantRemoved' as const, blockNumber: HEAD - 80 },
      { name: 'AgentParticipantAdded' as const, blockNumber: HEAD - 70 },
    ].map((event) => ({
      ...event, contextGraphId: 9n, blockHash: hash(event.blockNumber), index: 0, agent: OWNER,
    }));
    const readPage = vi.fn(async (from: number, to: number) => events.filter(
      (event) => event.blockNumber >= from && event.blockNumber <= to,
    ));
    const store = new ScopedStore();
    const state = await new ContextGraphAuthorityIndex(store, bootstrap()).resolve({ ...input(), readPage });
    expect(state).toMatchObject({ participantAgents: [OWNER], rosterVersion: 2, ownershipEra: 0, policyVersion: 0 });
    const restarted = new ContextGraphAuthorityIndex(store, bootstrap({ fetchSnapshot: async () => {
      throw new Error('durable generation must survive restart');
    } }));
    await expect(restarted.resolve(input())).resolves.toMatchObject({ participantAgents: [OWNER], rosterVersion: 2 });
  });

  it('reseeds an old local checkpoint without reading its historical gap', async () => {
    const store = new ScopedStore();
    store.records.set(`${SCOPE}:trusted-bootstrap:trusted-core-A`, { token: 8, value: checkpoint(20) });
    const source = bootstrap();
    const scan = input();
    await new ContextGraphAuthorityIndex(store, source).resolve(scan);
    expect(source.fetchSnapshot).toHaveBeenCalledOnce();
    expect(scan.readPage.mock.calls[0]?.[0]).toBe(HEAD - 99);
    expect(store.records.get(`${SCOPE}:trusted-bootstrap:trusted-core-A`)?.token).toBe(10);
  });

  it.each([
    ['wrong scope', () => ({ ...envelope(), scope: 'another-chain' })],
    ['wrong schema', () => ({ ...envelope(), version: 2 })],
    ['future prefix', () => envelope(checkpoint(HEAD + 1))],
    ['stale prefix', () => envelope(checkpoint(HEAD - 201))],
    ['unsafe durable prefix', () => envelope(checkpoint(HEAD - 1))],
    ['corrupt checkpoint', () => ({ ...envelope(), checkpoint: { ...checkpoint(), integrity: hash(99) } })],
    ['oversized response', () => ({ ...envelope(), padding: 'x'.repeat(CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES) })],
  ])('rejects %s with zero historical log reads', async (_label, seed) => {
    const store = new ScopedStore();
    const scan = input();
    await expect(new ContextGraphAuthorityIndex(store, bootstrap({ fetchSnapshot: async () => seed() }))
      .resolve(scan)).rejects.toThrow('snapshot is invalid');
    expect(scan.readPage).not.toHaveBeenCalled();
    expect(store.compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects a different deployment even when its checkpoint integrity is valid', async () => {
    const scan = { ...input(), deploymentBlockNumber: DEPLOYMENT + 1 };
    await expect(new ContextGraphAuthorityIndex(new ScopedStore(), bootstrap()).resolve(scan))
      .rejects.toThrow('snapshot is invalid');
    expect(scan.readPage).not.toHaveBeenCalled();
  });

  it('rejects an unavailable or replaced chain anchor without writing or scanning', async () => {
    const store = new ScopedStore();
    const scan = { ...input(), readBlockHash: async () => hash(0) };
    await expect(new ContextGraphAuthorityIndex(store, bootstrap()).resolve(scan))
      .rejects.toThrow('anchor is unavailable or replaced');
    expect(scan.readPage).not.toHaveBeenCalled();
    expect(store.compareAndSwap).not.toHaveBeenCalled();
  });

  it('lets the transport reject a bad first peer and validate another, without duplicate anchor RPCs', async () => {
    const scan = input();
    const source = bootstrap({ fetchSnapshot: async (_request, _signal, validate) => {
      await expect(validate({ ...envelope(), scope: 'wrong' })).rejects.toThrow('snapshot is invalid');
      await validate(envelope());
      return envelope();
    } });
    await new ContextGraphAuthorityIndex(new ScopedStore(), source).resolve(scan);
    expect(scan.readBlockHash.mock.calls.filter(([block]) => block === HEAD - 100)).toHaveLength(1);
  });

  it('does not fall back to history when all trusted cores are unavailable', async () => {
    const scan = input();
    await expect(new ContextGraphAuthorityIndex(new ScopedStore(), bootstrap({
      fetchSnapshot: async () => { throw new Error('trusted cores unavailable'); },
    })).resolve(scan)).rejects.toThrow('trusted cores unavailable');
    expect(scan.readPage).not.toHaveBeenCalled();
  });

  it('isolates a new trust domain and independently scanned local mode from imported state', async () => {
    const store = new ScopedStore();
    await new ContextGraphAuthorityIndex(store, bootstrap()).resolve(input());
    const sourceB = bootstrap({ trustDomain: 'trusted-core-B' });
    await new ContextGraphAuthorityIndex(store, sourceB).resolve(input());
    expect(sourceB.fetchSnapshot).toHaveBeenCalledOnce();
    expect(store.records.size).toBe(2);
    const readPage = vi.fn(async (_from: number, _to: number) => { throw new Error('independent scan'); });
    await expect(new ContextGraphAuthorityIndex(store).resolve(input(readPage))).rejects.toThrow('independent scan');
    expect(readPage.mock.calls[0]?.[0]).toBe(DEPLOYMENT);
  });

  it('reseeds after a durable anchor reorg instead of rescanning deployment history', async () => {
    const store = new ScopedStore();
    await new ContextGraphAuthorityIndex(store, bootstrap()).resolve(input());
    const source = bootstrap();
    const scan = { ...input(), readBlockHash: async (block: number) => block === HEAD - 50 ? hash(5) : hash(block) };
    await new ContextGraphAuthorityIndex(store, source).resolve(scan);
    expect(store.invalidate).toHaveBeenCalledOnce();
    expect(source.fetchSnapshot).toHaveBeenCalledOnce();
    expect(scan.readPage.mock.calls[0]?.[0]).toBe(HEAD - 99);
  });

  it('uses the newer CAS winner without rolling it back to the fetched seed', async () => {
    const store = new ScopedStore();
    store.compareAndSwap.mockImplementationOnce(async (scope) => {
      store.records.set(scope, { token: 1, value: checkpoint(HEAD - 80) });
      return undefined;
    });
    const scan = input();
    await new ContextGraphAuthorityIndex(store, bootstrap()).resolve(scan);
    expect(scan.readPage.mock.calls[0]?.[0]).toBe(HEAD - 79);
  });

  it('bounds repeated seed CAS losses before any historical scan', async () => {
    const store = new ScopedStore();
    store.compareAndSwap.mockImplementation(async (scope, token) => {
      store.records.set(scope, { token: (token ?? 0) + 1, value: checkpoint(20) });
      return undefined;
    });
    const source = bootstrap();
    const scan = input();
    await expect(new ContextGraphAuthorityIndex(store, source).resolve(scan))
      .rejects.toThrow('changed repeatedly during import');
    expect(source.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(scan.readPage).not.toHaveBeenCalled();
  });

  it('shares one deadline across peer walks and seed CAS retries, then cools down', async () => {
    vi.useFakeTimers();
    try {
      const store = new ScopedStore();
      store.compareAndSwap.mockImplementationOnce(async (scope) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
        store.records.set(scope, { token: 1, value: checkpoint(20) });
        return undefined;
      });
      const source = bootstrap({ fetchSnapshot: vi.fn(async (_request, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 12_000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        return envelope();
      }) });
      const index = new ContextGraphAuthorityIndex(store, source);
      const scan = input();
      const pending = index.resolve(scan);
      const rejected = expect(pending).rejects.toBeInstanceOf(ContextGraphAuthorityIndexBootstrapUnavailableError);
      await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS);
      await rejected;
      expect(source.fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(store.compareAndSwap).toHaveBeenCalledOnce();
      expect(scan.readPage).not.toHaveBeenCalled();
      await expect(index.resolve({ ...scan, readScope: {} })).rejects.toThrow('deadline exceeded');
      expect(source.fetchSnapshot).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      const retry = index.resolve({ ...scan, readScope: {} });
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(retry).resolves.toMatchObject({ owner: OWNER });
      expect(source.fetchSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the original seed deadline when a tail CAS loss requires another seed', async () => {
    vi.useFakeTimers();
    try {
      const store = new ScopedStore();
      const commit = store.compareAndSwap.getMockImplementation()!;
      store.compareAndSwap.mockImplementationOnce(commit).mockImplementationOnce(async (scope) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
        store.records.set(scope, { token: 2, value: checkpoint(20) });
        return undefined;
      });
      const source = bootstrap({ fetchSnapshot: vi.fn(async (_request, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 12_000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        return envelope();
      }) });
      const scan = input();
      const index = new ContextGraphAuthorityIndex(store, source);
      const rejected = expect(index.resolve(scan)).rejects.toThrow('deadline exceeded');
      await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS);
      await rejected;
      expect(source.fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(store.compareAndSwap).toHaveBeenCalledTimes(2);
      expect(scan.readPage.mock.calls).toEqual([[HEAD - 99, HEAD - 50, expect.any(AbortSignal)]]);
      await index.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns at the seed deadline and drains an in-flight CAS without launching a winner reload', async () => {
    vi.useFakeTimers();
    try {
      const store = new ScopedStore();
      store.compareAndSwap.mockImplementationOnce(async (scope) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 40_000));
        store.records.set(scope, { token: 1, value: checkpoint(20) });
        return undefined;
      });
      const source = bootstrap();
      const index = new ContextGraphAuthorityIndex(store, source);
      const scan = input();
      let settled = false;
      const pending = index.resolve(scan).finally(() => { settled = true; });
      const rejected = expect(pending).rejects.toThrow('deadline exceeded');
      await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS);
      expect(settled).toBe(true);
      await rejected;
      let drained = false;
      const close = index.close().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await close;
      expect(store.compareAndSwap).toHaveBeenCalledOnce();
      expect(source.fetchSnapshot).toHaveBeenCalledOnce();
      expect(store.load).toHaveBeenCalledOnce();
      expect(scan.readPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a detached caller seed and drains uncooperative transport during shutdown', async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      const source = bootstrap({ fetchSnapshot: vi.fn(async () => new Promise((resolve) => { release = resolve; })) });
      const index = new ContextGraphAuthorityIndex(new ScopedStore(), source);
      const caller = new AbortController();
      const scan = input();
      const pending = index.resolve({ ...scan, signal: caller.signal });
      const rejected = expect(pending).rejects.toThrow('caller left');
      await vi.advanceTimersByTimeAsync(1);
      caller.abort(new Error('caller left'));
      await rejected;
      await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS);
      expect(source.fetchSnapshot.mock.calls[0]?.[1].aborted).toBe(true);
      let drained = false;
      const close = index.close().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(drained).toBe(false);
      release(envelope());
      await close;
      expect(scan.readPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves peer failure causes in the caller-retryable bootstrap error', async () => {
    const peerCause = new Error('core-a 503');
    const aggregate = new AggregateError([peerCause], 'all trusted cores unavailable');
    const index = new ContextGraphAuthorityIndex(new ScopedStore(), bootstrap({
      fetchSnapshot: async () => { throw aggregate; },
    }));
    const error = await index.resolve(input()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ContextGraphAuthorityIndexBootstrapUnavailableError);
    expect(error).toMatchObject({ cause: aggregate, errors: [aggregate], retryAfterMs: 5_000 });
  });

  it('bounds canonical validation even when the RPC ignores abort and drains it on close', async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: string) => void;
      const store = new ScopedStore();
      const index = new ContextGraphAuthorityIndex(store, bootstrap());
      const scan = { ...input(), readBlockHash: async () => new Promise<string>((resolve) => { release = resolve; }) };
      const rejected = expect(index.resolve(scan)).rejects.toThrow('deadline exceeded');
      await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS);
      await rejected;
      let drained = false;
      const close = index.close().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(drained).toBe(false);
      release(hash(HEAD - 100));
      await close;
      expect(store.compareAndSwap).not.toHaveBeenCalled();
      expect(scan.readPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains candidate validation after the transport stops waiting on a timed-out peer', async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: string) => void;
      const store = new ScopedStore();
      const source = bootstrap({ fetchSnapshot: async (_request, _signal, validate) => {
        const attempt = new AbortController();
        setTimeout(() => attempt.abort(new Error('core attempt expired')), 5_000);
        const abandoned = new Promise<never>((_resolve, reject) => {
          attempt.signal.addEventListener('abort', () => reject(attempt.signal.reason), { once: true });
        });
        await Promise.race([validate(envelope(), attempt.signal), abandoned]);
        return envelope();
      } });
      const index = new ContextGraphAuthorityIndex(store, source);
      const scan = { ...input(), readBlockHash: async () => new Promise<string>((resolve) => { release = resolve; }) };
      const rejected = expect(index.resolve(scan)).rejects.toThrow('core attempt expired');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      let drained = false;
      const close = index.close().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(1);
      expect(drained).toBe(false);
      release(hash(HEAD - 100));
      await close;
      expect(store.compareAndSwap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps total local blocks even when concurrent CAS writers repeatedly discard tail progress', async () => {
    const store = new ScopedStore();
    store.records.set(`${SCOPE}:trusted-bootstrap:trusted-core-A`, { token: 1, value: checkpoint() });
    store.compareAndSwap.mockImplementation(async (scope, token) => {
      store.records.set(scope, { token: (token ?? 0) + 1, value: checkpoint() });
      return undefined;
    });
    const scan = input();
    await expect(new ContextGraphAuthorityIndex(store, bootstrap()).resolve(scan))
      .rejects.toThrow('local tail scan budget exhausted');
    const blocks = scan.readPage.mock.calls.reduce((total, [from, to]) => total + to - from + 1, 0);
    expect(blocks).toBe(200);
    expect(scan.readPage.mock.calls.every(([from]) => from === HEAD - 99)).toBe(true);
  });

  it('cancels canonical anchor validation with the failed peer attempt before trying another core', async () => {
    let calls = 0;
    const scan = { ...input(), readBlockHash: vi.fn(async (block: number, signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return hash(block);
    }) };
    const source = bootstrap({ fetchSnapshot: async (_request, _signal, validate) => {
      const attempt = new AbortController();
      const pending = validate(envelope(), attempt.signal);
      const rejected = expect(pending).rejects.toThrow('core timed out');
      attempt.abort(new Error('core timed out'));
      await rejected;
      await validate(envelope());
      return envelope();
    } });
    await new ContextGraphAuthorityIndex(new ScopedStore(), source).resolve(scan);
    expect(scan.readBlockHash.mock.calls[0]?.[1].aborted).toBe(true);
    expect(scan.readPage.mock.calls[0]?.[0]).toBe(HEAD - 99);
  });

  it('aborts and drains the shared seed request on close and allows a later open', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetchSnapshot = vi.fn<ContextGraphAuthorityIndexBootstrap['fetchSnapshot']>()
      .mockImplementationOnce(async (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      })).mockResolvedValue(envelope());
    const index = new ContextGraphAuthorityIndex(new ScopedStore(), bootstrap({ fetchSnapshot }));
    const pending = index.resolve(input());
    const rejected = expect(pending).rejects.toThrow('lifecycle cleared');
    await ready;
    await index.close();
    await rejected;
    await expect(index.resolve(input())).rejects.toThrow('closed');
    index.open();
    await expect(index.resolve(input())).resolves.toMatchObject({ owner: OWNER });
  });

  it('exports only a completed core refresh and never starts work for peer requests', async () => {
    const store = new ScopedStore();
    const index = new ContextGraphAuthorityIndex(store);
    const scan = { ...input(), finalized: { number: 110, hash: hash(110) } };
    const coreRequest = { ...request(), minThroughBlockNumber: 10, maxThroughBlockNumber: 110 };
    expect(index.exportSnapshot(coreRequest)).toBeNull();
    expect(store.load).not.toHaveBeenCalled();
    const readPage = vi.fn(async (from: number, _to: number) => {
      if (from > DEPLOYMENT) throw new Error('tail unavailable');
      return [];
    });
    await expect(index.refresh({ ...scan, readPage })).rejects.toThrow('tail unavailable');
    expect(index.exportSnapshot(coreRequest)).toBeNull();
    await index.refresh(scan);
    expect(index.exportSnapshot(coreRequest)?.checkpoint).toMatchObject({ cursor: { throughBlockNumber: 60 } });
    const reads = store.load.mock.calls.length;
    expect(index.exportSnapshot({ ...coreRequest, scope: 'peer-selected-scope' })).toBeNull();
    expect(store.load).toHaveBeenCalledTimes(reads);
  });

  it('serves the newest compatible completed checkpoint when the core is ahead of the edge', async () => {
    const index = new ContextGraphAuthorityIndex(new ScopedStore());
    await index.refresh(input());
    await index.refresh({ ...input(), finalized: { number: HEAD + 30, hash: hash(HEAD + 30) } });
    expect(index.exportSnapshot(request())?.checkpoint).toMatchObject({ cursor: { throughBlockNumber: HEAD - 50 } });
    expect(index.exportSnapshot({ ...request(), maxThroughBlockNumber: HEAD })?.checkpoint)
      .toMatchObject({ cursor: { throughBlockNumber: HEAD - 20 } });
    expect(() => index.exportSnapshot({ ...request(), minThroughBlockNumber: HEAD - 500, maxThroughBlockNumber: HEAD - 300 }))
      .toThrow(expect.objectContaining({ status: 'above-range' }));
    expect(() => index.exportSnapshot({ ...request(), minThroughBlockNumber: HEAD + 1, maxThroughBlockNumber: HEAD + 50 }))
      .toThrow(expect.objectContaining({ status: 'below-range' }));
  });

  it('bounds the cache to the eight most recent completed cursors', async () => {
    const index = new ContextGraphAuthorityIndex(new ScopedStore());
    for (let offset = 0; offset <= 80; offset += 10) {
      await index.refresh({ ...input(), finalized: { number: HEAD + offset, hash: hash(HEAD + offset) } });
    }
    expect(() => index.exportSnapshot({ ...request(), minThroughBlockNumber: HEAD - 50, maxThroughBlockNumber: HEAD - 50 }))
      .toThrow(expect.objectContaining({ status: 'above-range' }));
    expect(index.exportSnapshot({ ...request(), minThroughBlockNumber: HEAD - 40, maxThroughBlockNumber: HEAD - 40 }))
      .toMatchObject({ checkpoint: { cursor: { throughBlockNumber: HEAD - 40 } } });
  });

  it('evicts every servable checkpoint immediately on reorg even if rebuilding fails', async () => {
    const index = new ContextGraphAuthorityIndex(new ScopedStore());
    await index.refresh(input());
    expect(index.exportSnapshot(request())).not.toBeNull();
    const rebuilding = { ...input(), readBlockHash: async () => hash(1), readPage: async () => {
      expect(index.exportSnapshot(request())).toBeNull();
      throw new Error('rebuild unavailable');
    } };
    await expect(index.refresh(rebuilding)).rejects.toThrow('rebuild unavailable');
    expect(index.exportSnapshot(request())).toBeNull();
  });

  it('does not republish an older in-flight completion after a concurrent reorg rejection', async () => {
    const index = new ContextGraphAuthorityIndex(new ScopedStore());
    await index.refresh(input());
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const earlier = index.refresh({ ...input(), readPage: async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return [];
    } });
    await ready;
    await expect(index.refresh({ ...input(), readBlockHash: async () => hash(1), readPage: async () => {
      throw new Error('rebuild unavailable');
    } })).rejects.toThrow('rebuild unavailable');
    release();
    await earlier;
    expect(index.exportSnapshot(request())).toBeNull();
  });

  it('reports an oversized completed table explicitly without retaining its payload for serving', async () => {
    const seed = checkpoint();
    const count = Math.ceil(CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES / JSON.stringify(seed.states[0]).length) + 100;
    const large = createContextGraphAuthorityIndexCheckpoint(seed.cursor, Array.from({ length: count }, (_, id) => ({
      ...seed.states[0]!, contextGraphId: String(id + 1) as ContextGraphAuthorityIndexId,
    })));
    expect(JSON.stringify(envelope(large)).length).toBeGreaterThan(CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES);
    const store = new ScopedStore();
    store.records.set(SCOPE, { token: 1, value: large });
    const index = new ContextGraphAuthorityIndex(store);
    await index.refresh({ ...input(), finalized: { number: seed.cursor.throughBlockNumber, hash: seed.cursor.throughBlockHash } });
    expect(() => index.exportSnapshot(request())).toThrow(expect.objectContaining({ status: 'too-large' }));
  });

  it('normalizes the portable envelope without turning its integrity hash into proof', () => {
    expect(normalizeContextGraphAuthorityIndexSnapshot(envelope(), request())).toEqual(envelope());
    expect(normalizeContextGraphAuthorityIndexSnapshot(envelope(), { ...request(), scope: 'other' })).toBeUndefined();
  });
});
