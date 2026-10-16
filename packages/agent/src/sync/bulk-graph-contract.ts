// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { BULK_GRAPH_MAX_ASSETS, BULK_GRAPH_CHUNK_BYTES, parseDeterministicKnowledgeAssetUal, validateContextGraphId, snapshotExactDataRecord, isClosedDataRecord } from '@origintrail-official/dkg-core';
import { ATOMIC_ASSET_GROUP_MAX_ASSETS } from '@origintrail-official/dkg-storage';
import { EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES } from './wire-compression.js';
export const BULK_STAGING_BYTES = 16 * 1024 * 1024;
export const BULK_STAGING_ASSETS = 32;
export const BULK_GROUP_ASSETS = ATOMIC_ASSET_GROUP_MAX_ASSETS;
export const BULK_GROUP_HEAP_BYTES = 64 * 1024 * 1024;
export const BULK_GROUP_EXPANDED_BYTES = 8 * 1024 * 1024;
export interface BulkGraphRequest { version: 1; contextGraphId: string; snapshotDigest: string; assetUals: string[] }
export function validateBulkGraphRequest(value: unknown): BulkGraphRequest {
  const v = snapshotExactDataRecord(value, ['version', 'contextGraphId', 'snapshotDigest', 'assetUals'], 'Invalid bulk graph request');
  if (v.version !== 1 || typeof v.contextGraphId !== 'string' || !validateContextGraphId(v.contextGraphId).valid
    || typeof v.snapshotDigest !== 'string' || !/^(0x)?[a-f0-9]{64}$/i.test(v.snapshotDigest)
    || !Array.isArray(v.assetUals) || !v.assetUals.length || v.assetUals.length > BULK_GRAPH_MAX_ASSETS)
    throw new Error('Invalid bulk graph request');
  const selection: unknown[] = v.assetUals;
  const assetUals = selection.map(ual => {
    if (typeof ual !== 'string') throw new Error('Invalid bulk asset identity');
    return parseDeterministicKnowledgeAssetUal(ual).ual;
  });
  if (new Set(assetUals).size !== assetUals.length || assetUals.some((a,i) => a !== selection[i])) throw new Error('Noncanonical bulk graph selection');
  return { version: 1, contextGraphId: v.contextGraphId, snapshotDigest: v.snapshotDigest, assetUals };
}
export const bulkJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const readBulkJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export interface BulkChunkEnd { digest: string; assets: number; encodedBytes: number }
export interface BulkRefusal { code: 'RESOURCE_LIMIT' }
export const encodeBulkChunkEnd = (value: BulkChunkEnd) => bulkJson(value);
export const encodeBulkRefusal = (value: BulkRefusal) => bulkJson(value);
export function parseBulkChunkEnd(bytes: Uint8Array): BulkChunkEnd {
  const value = readBulkJson(bytes);
  if (!isClosedDataRecord(value) || typeof value.digest !== 'string' || typeof value.assets !== 'number' || typeof value.encodedBytes !== 'number')
    throw new Error('Bulk chunk directory digest or coverage mismatch');
  return { digest: value.digest, assets: value.assets, encodedBytes: value.encodedBytes };
}
export function parseBulkRefusal(bytes: Uint8Array): BulkRefusal {
  const value = readBulkJson(bytes);
  if (!isClosedDataRecord(value) || value.code !== 'RESOURCE_LIMIT') throw new Error('Invalid bulk graph refusal');
  return { code: value.code };
}
/** Length-bound directory hash: generation, ordered asset identities, metadata and exact encoding. */
export function bulkChunkHash(request: BulkGraphRequest) {
  // Request field order is not semantic; asset selection order remains part of the digest.
  return createHash('sha256').update(bulkJson({
    version: request.version, contextGraphId: request.contextGraphId,
    snapshotDigest: request.snapshotDigest, assetUals: request.assetUals,
  }));
}
export interface BulkAssetHeader { encodedBytes: number; plainBytes: number; offset: number; digest: string; metadata: string }
export function parseBulkAssetHeader(bytes: Uint8Array): BulkAssetHeader {
  const h = snapshotExactDataRecord(readBulkJson(bytes),
    ['encodedBytes', 'plainBytes', 'offset', 'digest', 'metadata'], 'Invalid bulk asset directory record');
  if (typeof h.encodedBytes !== 'number' || !Number.isSafeInteger(h.encodedBytes) || h.encodedBytes < 1 || h.encodedBytes > EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES
    || typeof h.plainBytes !== 'number' || !Number.isSafeInteger(h.plainBytes) || h.plainBytes < 1 || h.plainBytes > EXACT_SYNC_GZIP_MAX_INFLATED_BYTES
    || typeof h.offset !== 'number' || !Number.isSafeInteger(h.offset) || h.offset < 0 || h.offset > BULK_GRAPH_CHUNK_BYTES
    || typeof h.digest !== 'string' || !/^[a-f0-9]{64}$/.test(h.digest)
    || typeof h.metadata !== 'string' || h.metadata.length > 88_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(h.metadata))
    throw new Error('Invalid bulk asset directory record');
  return { encodedBytes: h.encodedBytes, plainBytes: h.plainBytes, offset: h.offset, digest: h.digest, metadata: h.metadata };
}
