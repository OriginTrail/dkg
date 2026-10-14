// SPDX-License-Identifier: Apache-2.0
import { PublicSnapshotServingRuntime } from '../src/public-snapshot-serving-runtime.js';
import { getEventListeners } from 'node:events';
import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import {
  sealPublicGraphSnapshot,
} from "@origintrail-official/dkg-chain";
const scope = {
  chainId: "evm:31337",
  deploymentId: "test-hub",
  contextGraphId: "snapshot-test",
  onChainId: "1",
};
const make = () =>
  sealPublicGraphSnapshot({
    version: 1,
    ...scope,
    nameHash: ethers.id(scope.contextGraphId),
    contextGraphStorage: `0x${"1".repeat(40)}`,
    assetStorage: `0x${"2".repeat(40)}`,
    blockNumber: "10",
    blockHash: `0x${"a".repeat(64)}`,
    finalityConfirmations: 1,
    observedAt: 1000,
    expiresAt: 121000,
    accessPolicy: 0,
    assets: [{ id: "1", root: `0x${"b".repeat(64)}`, version: "1" }],
  });
const lifetime = () => ({ signal: new AbortController().signal, physicalRuns: new Set<Promise<unknown>>() });
describe("public snapshot serving cache", () => {
  it("coalesces cold readers and serves a warm snapshot without more reads", async () => {
    let now = 1000;
    const read = vi.fn(async () => make());
    const cache = new PublicSnapshotServingRuntime(read, lifetime(), () => now);
    const [a, b] = await Promise.all([
      cache.get("peer-a", "g", "1"),
      cache.get("peer-a", "g", "1"),
    ]);
    expect(a).toBe(b);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.get("peer-a", "g", "1");
    expect(read).toHaveBeenCalledTimes(1);
    now = 31000;
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(cache.get("peer-a", "g", "1")).rejects.toThrow("offline");
    expect(read).toHaveBeenCalledTimes(2);
    await cache.get("peer-b", "g", "1");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("refreshes a warm snapshot for a post-transfer observation", async () => {
    let now = 1000;
    const read = vi.fn(async () => ({ ...make(), observedAt: now }));
    const cache = new PublicSnapshotServingRuntime(read, lifetime(), () => now);
    await cache.get("peer-a", "g", "1");
    now = 1100;
    expect((await cache.get("peer-a", "g", "1", true)).observedAt).toBe(1100);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("forces a second build when refresh arrives during an older pending read", async () => {
    const releases: Array<(value: ReturnType<typeof make>) => void> = [];
    const read = vi.fn(() => new Promise<ReturnType<typeof make>>(resolve => releases.push(resolve)));
    const cache = new PublicSnapshotServingRuntime(read, lifetime(), () => 1000);
    const cold = cache.get("peer-a", "g", "1");
    let refreshed = false;
    const refresh = cache.get("peer-a", "g", "1", true).then(value => { refreshed = true; return value; });
    const first = make(); releases[0]!(first);
    expect(await cold).toBe(first);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(refreshed).toBe(false);
    const second = make(); releases[1]!(second);
    expect(await refresh).toBe(second);
    expect(await cache.get("peer-a", "g", "1")).toBe(second);
  });

  it("bounds retained entries and rebuilds an evicted key", async () => {
    const read = vi.fn(async () => make());
    const cache = new PublicSnapshotServingRuntime(read, lifetime(), () => 1000);
    for (let n = 0; n < 9; n++) await cache.get(`peer-${n}`, `graph-${n}`, "1");
    await cache.get("peer-a", "graph-8", "1");
    expect(read).toHaveBeenCalledTimes(9);
    await cache.get("peer-final", "graph-0", "1");
    expect(read).toHaveBeenCalledTimes(10);
  });

});

describe('public snapshot serving lifecycle', () => {
  it('holds physical ownership through shutdown until an abort-ignoring reader settles', async () => {
    const stop = new AbortController(), physicalRuns = new Set<Promise<unknown>>();
    let release!: (value: ReturnType<typeof make>) => void;
    let signal!: AbortSignal;
    const read = vi.fn((_id: string, _chain: string, current: AbortSignal) => {
      signal = current;
      return new Promise<ReturnType<typeof make>>(resolve => { release = resolve; });
    });
    const runtime = new PublicSnapshotServingRuntime(read, { signal: stop.signal, physicalRuns }, () => 1000);
    const pending = runtime.get('peer-a', 'g', '1');
    const reason = new Error('node stopped');
    const rejected = expect(pending).rejects.toBe(reason);
    expect(physicalRuns.size).toBe(1);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(1);
    stop.abort(reason);
    expect(signal.aborted).toBe(true);
    expect(physicalRuns.size).toBe(1);
    await expect(runtime.get('peer-b', 'g', '1')).rejects.toBe(reason);
    const drained = Promise.allSettled(physicalRuns);
    release(make()); await rejected; await drained;
    expect(read).toHaveBeenCalledTimes(1);
    expect(physicalRuns.size).toBe(0);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it('uses one 110-second build deadline and releases it after physical settlement', async () => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController(), physicalRuns = new Set<Promise<unknown>>();
      let release!: (value: ReturnType<typeof make>) => void;
      let signal!: AbortSignal;
      const runtime = new PublicSnapshotServingRuntime((_id, _chain, current) => {
        signal = current;
        return new Promise(resolve => { release = resolve; });
      }, { signal: stop.signal, physicalRuns }, () => 1000);
      const pending = runtime.get('peer-a', 'g', '1');
      const rejected = expect(pending).rejects.toBeInstanceOf(Error);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(109_999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(physicalRuns.size).toBe(1);
      release(make()); await rejected;
      expect(physicalRuns.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('releases admission and listeners when a reader throws synchronously', async () => {
    const stop = new AbortController(), physicalRuns = new Set<Promise<unknown>>();
    const read = vi.fn(() => { throw new Error('sync RPC failure'); });
    const runtime = new PublicSnapshotServingRuntime(read, { signal: stop.signal, physicalRuns });
    await expect(runtime.get('peer-a', 'g', '1')).rejects.toThrow('sync RPC failure');
    await expect(runtime.get('peer-a', 'other', '1')).rejects.toThrow('sync RPC failure');
    expect(read).toHaveBeenCalledTimes(2);
    expect(physicalRuns.size).toBe(0);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });
});
