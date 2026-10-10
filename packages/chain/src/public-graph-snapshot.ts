// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { ethers } from "ethers";

/** Public chain statements, not a light-client proof. All integers are canonical decimal strings. */
export interface PublicGraphSnapshot {
  version: 1;
  chainId: string;
  deploymentId: string;
  contextGraphId: string;
  onChainId: string;
  nameHash: string;
  contextGraphStorage: string;
  assetStorage: string;
  blockNumber: string;
  blockHash: string;
  finalityConfirmations: number;
  observedAt: number;
  expiresAt: number;
  accessPolicy: 0;
  assets: PublicGraphSnapshotAsset[];
  inventoryDigest: string;
  snapshotDigest: string;
}
export interface PublicGraphSnapshotAsset {
  id: string;
  root: string;
  version: string;
}
export const PUBLIC_GRAPH_SNAPSHOT_MAX_ASSETS = 10_000;
export const PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const PUBLIC_GRAPH_SNAPSHOT_MAX_AGE_MS = 120_000;
export const PUBLIC_GRAPH_SNAPSHOT_CLOCK_SKEW_MS = 5_000;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decimal = (value: unknown, positive = false): value is string =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]{0,77})$/.test(value) &&
  (!positive || BigInt(value) > 0n) &&
  BigInt(value) < 2n ** 256n;
const hex = (value: unknown, size: number): value is string =>
  typeof value === "string" &&
  new RegExp(`^0x[0-9a-f]{${size * 2}}$`).test(value);
const keys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(",") === expected.sort().join(",");
export function sealPublicGraphSnapshot(
  input: Omit<PublicGraphSnapshot, "inventoryDigest" | "snapshotDigest">,
): PublicGraphSnapshot {
  const snapshot = { ...input, inventoryDigest: hash(input.assets) };
  return { ...snapshot, snapshotDigest: hash(snapshot) };
}
/** Strict wire validation and a detached copy prevent mutable peer objects from changing a job's evidence. */
export function decodePublicGraphSnapshot(
  bytes: Uint8Array,
  expected: {
    chainId: string;
    deploymentId: string;
    contextGraphId: string;
    onChainId: string;
    now?: number;
  },
): PublicGraphSnapshot {
  if (!bytes.length || bytes.length > PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES)
    throw new Error("Snapshot size exceeds bound");
  const s = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as PublicGraphSnapshot;
  if (
    !s ||
    typeof s !== "object" ||
    !keys(s, [
      "version",
      "chainId",
      "deploymentId",
      "contextGraphId",
      "onChainId",
      "nameHash",
      "contextGraphStorage",
      "assetStorage",
      "blockNumber",
      "blockHash",
      "finalityConfirmations",
      "observedAt",
      "expiresAt",
      "accessPolicy",
      "assets",
      "inventoryDigest",
      "snapshotDigest",
    ])
  )
    throw new Error("Invalid snapshot fields");
  const now = expected.now ?? Date.now();
  if (
    s.version !== 1 ||
    s.accessPolicy !== 0 ||
    s.chainId !== expected.chainId ||
    s.deploymentId !== expected.deploymentId ||
    s.contextGraphId !== expected.contextGraphId ||
    s.onChainId !== expected.onChainId ||
    !decimal(s.onChainId, true) ||
    !decimal(s.blockNumber) ||
    !hex(s.blockHash, 32) ||
    !hex(s.contextGraphStorage, 20) ||
    !hex(s.assetStorage, 20) ||
    s.nameHash !==
      ethers
        .keccak256(ethers.toUtf8Bytes(expected.contextGraphId))
        .toLowerCase() ||
    !Number.isSafeInteger(s.finalityConfirmations) ||
    s.finalityConfirmations < 1 ||
    !Number.isSafeInteger(s.observedAt) ||
    !Number.isSafeInteger(s.expiresAt) ||
    s.observedAt > now + PUBLIC_GRAPH_SNAPSHOT_CLOCK_SKEW_MS ||
    now >= s.expiresAt + PUBLIC_GRAPH_SNAPSHOT_CLOCK_SKEW_MS ||
    s.expiresAt <= s.observedAt ||
    s.expiresAt - s.observedAt > PUBLIC_GRAPH_SNAPSHOT_MAX_AGE_MS ||
    !Array.isArray(s.assets) ||
    s.assets.length > PUBLIC_GRAPH_SNAPSHOT_MAX_ASSETS
  )
    throw new Error("Invalid, stale or mis-scoped snapshot");
  const seen = new Set<string>();
  for (const a of s.assets) {
    if (
      !a ||
      !keys(a, ["id", "root", "version"]) ||
      !decimal(a.id, true) ||
      !decimal(a.version, true) ||
      !hex(a.root, 32) ||
      /^0x0+$/.test(a.root) ||
      seen.has(a.id)
    )
      throw new Error("Invalid or duplicate snapshot asset");
    seen.add(a.id);
  }
  // Reconstruct in canonical field order: wire object ordering is immaterial.
  const canonical = sealPublicGraphSnapshot({
    version: 1,
    chainId: s.chainId,
    deploymentId: s.deploymentId,
    contextGraphId: s.contextGraphId,
    onChainId: s.onChainId,
    nameHash: s.nameHash,
    contextGraphStorage: s.contextGraphStorage,
    assetStorage: s.assetStorage,
    blockNumber: s.blockNumber,
    blockHash: s.blockHash,
    finalityConfirmations: s.finalityConfirmations,
    observedAt: s.observedAt,
    expiresAt: s.expiresAt,
    accessPolicy: 0,
    assets: s.assets.map((a) => ({
      id: a.id,
      root: a.root,
      version: a.version,
    })),
  });
  if (
    canonical.inventoryDigest !== s.inventoryDigest ||
    canonical.snapshotDigest !== s.snapshotDigest
  )
    throw new Error("Snapshot digest mismatch");
  for (const asset of canonical.assets) Object.freeze(asset);
  Object.freeze(canonical.assets);
  return Object.freeze(canonical);
}

/** Bounded per-node warm cache; failures never replace the last good snapshot or extend its age. */
export class PublicGraphSnapshotCache {
  private readonly entries = new Map<string, { snapshot: PublicGraphSnapshot; sequence: number }>();
  private readonly pending = new Map<string, { promise: Promise<PublicGraphSnapshot>; sequence: number }>();
  constructor(
    private readonly read: (
      id: string,
      onChainId: string,
      signal: AbortSignal,
    ) => Promise<PublicGraphSnapshot>,
    private readonly clock: () => number = Date.now,
  ) {}
  private sequence = 0;
  async get(id: string, onChainId: string, refresh = false): Promise<PublicGraphSnapshot> {
    const key = JSON.stringify([id, onChainId]);
    // A forced observation must begin after THIS request, in the supplier's
    // own ordering domain. Never compare clocks belonging to different nodes.
    const minimum = refresh ? this.sequence + 1 : 0;
    for (;;) {
      const cached = this.entries.get(key);
      if (cached && cached.sequence >= minimum
        && this.clock() - cached.snapshot.observedAt < 30_000 && this.clock() < cached.snapshot.expiresAt) return cached.snapshot;
      const current = this.pending.get(key);
      if (current) {
        const result = await current.promise;
        if (current.sequence >= minimum) return result;
        continue;
      }
      if (this.pending.size >= 2) throw new Error("Snapshot builder busy");
      const sequence = ++this.sequence;
      const operation = this.read(id, onChainId, AbortSignal.timeout(110_000)).then(snapshot => {
        if (this.entries.size >= 8) {
          const oldest = this.entries.keys().next().value!;
          this.entries.delete(oldest);
        }
        this.entries.set(key, { snapshot, sequence });
        return snapshot;
      }).finally(() => { this.pending.delete(key); });
      this.pending.set(key, { promise: operation, sequence });
      return operation;
    }
  }
}
