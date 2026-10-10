import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import {
  sealPublicGraphSnapshot,
  decodePublicGraphSnapshot,
  PublicGraphSnapshotCache,
} from "../src/public-graph-snapshot.js";
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
const reseal = (patch: object) => {
  const { inventoryDigest: _i, snapshotDigest: _s, ...base } = make();
  return sealPublicGraphSnapshot({ ...base, ...patch } as any);
};
const bytes = (s: unknown) => Buffer.from(JSON.stringify(s));
describe("public graph snapshot contract", () => {
  it("accepts a scoped coherent inventory and detaches/freezes it", () => {
    const raw = make();
    const decoded = decodePublicGraphSnapshot(bytes(raw), {
      ...scope,
      now: 2000,
    });
    raw.assets[0]!.root = `0x${"c".repeat(64)}`;
    expect(decoded.assets[0]!.root).not.toBe(raw.assets[0]!.root);
    expect(Object.isFrozen(decoded.assets[0])).toBe(true);
  });
  it.each(["chainId", "deploymentId", "contextGraphId", "onChainId"] as const)(
    "rejects a different %s",
    (key) => {
      expect(() =>
        decodePublicGraphSnapshot(bytes(make()), {
          ...scope,
          [key]: "different",
          now: 2000,
        }),
      ).toThrow();
    },
  );
  it.each([
    { expiresAt: 2000 },
    { observedAt: 18000 },
    { accessPolicy: 1 },
    { nameHash: `0x${"c".repeat(64)}` },
    { blockNumber: "01" },
    { finalityConfirmations: 0 },
    { assets: [{ id: "1", root: `0x${"b".repeat(64)}`, version: "01" }] },
    { assets: [...make().assets, ...make().assets] },
    { unexpected: true },
  ])("rejects malformed or stale facts %j", (patch) => {
    expect(() =>
      decodePublicGraphSnapshot(bytes(reseal(patch)), {
        ...scope,
        now: 8000,
      }),
    ).toThrow("assets" in patch ? "Invalid or duplicate snapshot asset" : "unexpected" in patch ? "Invalid snapshot fields" : "Invalid, stale or mis-scoped snapshot");
  });
  it("accepts bounded clock skew in both directions without accepting old snapshots", () => {
    for (const now of [-3000, 124000]) expect(decodePublicGraphSnapshot(bytes(make()), { ...scope, now }).assets).toHaveLength(1);
    for (const now of [-5000, 126000]) expect(() => decodePublicGraphSnapshot(bytes(make()), { ...scope, now })).toThrow("stale");
  });
  it("rejects truncation and changed roots even with an intact inventory count", () => {
    const s = make();
    s.assets[0]!.root = `0x${"c".repeat(64)}`;
    expect(() =>
      decodePublicGraphSnapshot(bytes(s), { ...scope, now: 2000 }),
    ).toThrow("digest");
    expect(() =>
      decodePublicGraphSnapshot(bytes(s).subarray(0, 50), {
        ...scope,
        now: 2000,
      }),
    ).toThrow();
  });
  it("coalesces cold readers and serves a warm snapshot without more reads", async () => {
    let now = 1000;
    const read = vi.fn(async () => make());
    const cache = new PublicGraphSnapshotCache(read, () => now);
    const [a, b] = await Promise.all([
      cache.get("g", "1"),
      cache.get("g", "1"),
    ]);
    expect(a).toBe(b);
    expect(read).toHaveBeenCalledTimes(1);
    await cache.get("g", "1");
    expect(read).toHaveBeenCalledTimes(1);
    now = 31000;
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(cache.get("g", "1")).rejects.toThrow("offline");
    expect(read).toHaveBeenCalledTimes(2);
    await cache.get("g", "1");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("refreshes a warm snapshot for a post-transfer observation", async () => {
    let now = 1000;
    const read = vi.fn(async () => ({ ...make(), observedAt: now }));
    const cache = new PublicGraphSnapshotCache(read, () => now);
    await cache.get("g", "1");
    now = 1100;
    expect((await cache.get("g", "1", true)).observedAt).toBe(1100);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
