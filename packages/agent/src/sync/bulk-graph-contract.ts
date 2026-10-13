// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { BULK_GRAPH_MAX_ASSETS, BULK_GRAPH_CHUNK_BYTES, validateContextGraphId } from '@origintrail-official/dkg-core';
import { ATOMIC_ASSET_GROUP_MAX_ASSETS } from '@origintrail-official/dkg-storage';
import { EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES } from './wire-compression.js';
import { requireExactAssetUals } from './exact-assets.js';
export const BULK_STAGING_BYTES = 16 * 1024 * 1024;
export const BULK_STAGING_ASSETS = 32;
export const BULK_GROUP_ASSETS = ATOMIC_ASSET_GROUP_MAX_ASSETS;
export const BULK_GROUP_HEAP_BYTES = 64 * 1024 * 1024;
export const BULK_GROUP_EXPANDED_BYTES = 8 * 1024 * 1024;
export interface BulkGraphRequest { version: 1; contextGraphId: string; snapshotDigest: string; assetUals: string[] }
export function validateBulkGraphRequest(value: unknown): BulkGraphRequest {
  const v = value as BulkGraphRequest;
  if (!v || Object.keys(v).sort().join(',') !== 'assetUals,contextGraphId,snapshotDigest,version'
    || v.version !== 1 || typeof v.contextGraphId !== 'string' || !validateContextGraphId(v.contextGraphId).valid
    || typeof v.snapshotDigest !== 'string' || !/^(0x)?[a-f0-9]{64}$/i.test(v.snapshotDigest)
    || !Array.isArray(v.assetUals) || !v.assetUals.length || v.assetUals.length > BULK_GRAPH_MAX_ASSETS)
    throw new Error('Invalid bulk graph request');
  const assetUals = v.assetUals.map(ual => requireExactAssetUals([ual])[0]!);
  if (new Set(assetUals).size !== assetUals.length || assetUals.some((a,i) => a !== v.assetUals[i])) throw new Error('Noncanonical bulk graph selection');
  return { version: 1, contextGraphId: v.contextGraphId, snapshotDigest: v.snapshotDigest, assetUals };
}
export const bulkJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const readBulkJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
/** Length-bound directory hash: generation, ordered asset identities, metadata and exact encoding. */
export function bulkChunkHash(request: BulkGraphRequest) {
  return createHash('sha256').update(bulkJson(request));
}
export interface BulkAssetHeader { encodedBytes: number; plainBytes: number; offset: number; digest: string; metadata: string }
export function parseBulkAssetHeader(bytes: Uint8Array): BulkAssetHeader {
  const h = readBulkJson(bytes) as BulkAssetHeader;
  if (!h || Object.keys(h).sort().join(',') !== 'digest,encodedBytes,metadata,offset,plainBytes'
    || !Number.isSafeInteger(h.encodedBytes) || h.encodedBytes < 1 || h.encodedBytes > EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES
    || !Number.isSafeInteger(h.plainBytes) || h.plainBytes < 1 || h.plainBytes > EXACT_SYNC_GZIP_MAX_INFLATED_BYTES
    || !Number.isSafeInteger(h.offset) || h.offset < 0 || h.offset > BULK_GRAPH_CHUNK_BYTES
    || typeof h.digest !== 'string' || !/^[a-f0-9]{64}$/.test(h.digest)
    || typeof h.metadata !== 'string' || h.metadata.length > 88_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(h.metadata))
    throw new Error('Invalid bulk asset directory record');
  return h;
}
