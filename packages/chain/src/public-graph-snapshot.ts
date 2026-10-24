// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { isCanonicalSnapshotInteger as decimal, isPublicGraphSnapshotScope } from "./public-graph-snapshot-scope.js";

/** Public chain statements, not a light-client proof. All integers are canonical decimal strings. */
export interface PublicGraphSnapshot {
  readonly version: 1;
  readonly chainId: string;
  readonly deploymentId: string;
  readonly contextGraphId: string;
  readonly onChainId: string;
  readonly nameHash: string;
  readonly contextGraphStorage: string;
  readonly assetStorage: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly finalityConfirmations: number;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly accessPolicy: 0;
  readonly assets: readonly PublicGraphSnapshotAsset[];
  readonly inventoryDigest: string;
  readonly snapshotDigest: string;
}
declare const acceptedSnapshot: unique symbol;
/** Validated, detached and deeply immutable; only normalization creates this value. */
export type AcceptedPublicGraphSnapshot = PublicGraphSnapshot & { readonly [acceptedSnapshot]: true };
export interface PublicGraphSnapshotAsset {
  readonly id: string;
  readonly root: string;
  readonly version: string;
}
export const PUBLIC_GRAPH_SNAPSHOT_MAX_ASSETS = 10_000;
export const PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const PUBLIC_GRAPH_SNAPSHOT_MAX_AGE_MS = 120_000;
export const PUBLIC_GRAPH_SNAPSHOT_CLOCK_SKEW_MS = 5_000;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = (value: unknown, size: number): value is string =>
  typeof value === "string" &&
  new RegExp(`^0x[0-9a-f]{${size * 2}}$`).test(value);
const keys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(",") === expected.sort().join(",");
export function sealPublicGraphSnapshot(
  input: Omit<PublicGraphSnapshot, "inventoryDigest" | "snapshotDigest">,
): PublicGraphSnapshot {
  const canonical = {
    version: input.version,
    chainId: input.chainId,
    deploymentId: input.deploymentId,
    contextGraphId: input.contextGraphId,
    onChainId: input.onChainId,
    nameHash: input.nameHash,
    contextGraphStorage: input.contextGraphStorage,
    assetStorage: input.assetStorage,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    finalityConfirmations: input.finalityConfirmations,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    accessPolicy: input.accessPolicy,
    assets: input.assets.map((a) => ({
      id: a.id,
      root: a.root,
      version: a.version,
    })),
  };
  const snapshot = { ...canonical, inventoryDigest: hash(canonical.assets) };
  return { ...snapshot, snapshotDigest: hash(snapshot) };
}
export interface PublicGraphSnapshotScope {
  chainId: string;
  deploymentId: string;
  contextGraphId: string;
  onChainId: string;
  now?: number;
}
/** The wire boundary owns byte size, UTF-8 and JSON decoding only. */
export function decodePublicGraphSnapshot(
  bytes: Uint8Array,
  expected: PublicGraphSnapshotScope,
): AcceptedPublicGraphSnapshot {
  if (!bytes.length || bytes.length > PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES)
    throw new Error("Snapshot size exceeds bound");
  return normalizePublicGraphSnapshot(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), expected,
  );
}
/** Validate and detach either an adapter result or a decoded peer object. */
export function normalizePublicGraphSnapshot(
  input: unknown,
  expected: PublicGraphSnapshotScope,
): AcceptedPublicGraphSnapshot {
  const s = input as PublicGraphSnapshot;
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
    !isPublicGraphSnapshotScope(s) ||
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
  const canonical = sealPublicGraphSnapshot(s);
  if (
    canonical.inventoryDigest !== s.inventoryDigest ||
    canonical.snapshotDigest !== s.snapshotDigest
  )
    throw new Error("Snapshot digest mismatch");
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES)
    throw new Error("Snapshot size exceeds bound");
  for (const asset of canonical.assets) Object.freeze(asset);
  Object.freeze(canonical.assets);
  return Object.freeze(canonical) as AcceptedPublicGraphSnapshot;
}
