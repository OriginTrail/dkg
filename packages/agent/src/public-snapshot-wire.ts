// SPDX-License-Identifier: Apache-2.0
import { isPublicGraphSnapshotScope } from '@origintrail-official/dkg-chain';

export const PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES = 1024;
export interface PublicGraphSnapshotRequest {
  version: 1;
  contextGraphId: string;
  onChainId: string;
  refresh: boolean;
}

export interface CoreChainCacheSnapshotRequest extends PublicGraphSnapshotRequest {
  chainId: string;
  deploymentId: string;
}

function validateCacheRequest(value: unknown): CoreChainCacheSnapshotRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid snapshot request');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'chainId,contextGraphId,deploymentId,onChainId,refresh,version'
    || typeof r.chainId !== 'string' || !r.chainId.length || r.chainId.length > 256
    || typeof r.deploymentId !== 'string' || !r.deploymentId.length || r.deploymentId.length > 256)
    throw new Error('Invalid snapshot request');
  return { ...validateRequest({ version: r.version, contextGraphId: r.contextGraphId,
    onChainId: r.onChainId, refresh: r.refresh }), chainId: r.chainId, deploymentId: r.deploymentId };
}

export function encodeCoreChainCacheSnapshotRequest(request: CoreChainCacheSnapshotRequest): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(validateCacheRequest(request)));
  assertRequestSize(bytes);
  return bytes;
}

export function decodeCoreChainCacheSnapshotRequest(bytes: Uint8Array): CoreChainCacheSnapshotRequest {
  assertRequestSize(bytes);
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return validateCacheRequest(value);
}

function validateRequest(value: unknown): PublicGraphSnapshotRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid snapshot request');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(',') !== 'contextGraphId,onChainId,refresh,version'
    || request.version !== 1 || typeof request.refresh !== 'boolean'
    || !isPublicGraphSnapshotScope(request)) {
    throw new Error('Invalid snapshot request');
  }
  return { version: 1, contextGraphId: request.contextGraphId, onChainId: request.onChainId, refresh: request.refresh };
}

function assertRequestSize(bytes: Uint8Array): void {
  if (bytes.byteLength > PUBLIC_GRAPH_SNAPSHOT_REQUEST_MAX_BYTES) throw new Error('Snapshot request too large');
}

export function encodePublicGraphSnapshotRequest(request: PublicGraphSnapshotRequest): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(validateRequest(request)));
  assertRequestSize(bytes);
  return bytes;
}

export function decodePublicGraphSnapshotRequest(bytes: Uint8Array): PublicGraphSnapshotRequest {
  assertRequestSize(bytes);
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return validateRequest(value);
}
