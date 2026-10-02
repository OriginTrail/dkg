// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES,
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TAIL_BLOCKS,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from '@origintrail-official/dkg-chain';

/** A bootstrap protocol: never resolve catalog/phonebook authority to serve it. */
export const PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT = '/dkg/10.0.0/authority-index-snapshot/1';
export const AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES = 2_048;
export const AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES = CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES;
export const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validBlock(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateRequest(
  value: unknown,
  maxTailBlocks = CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TAIL_BLOCKS,
): ContextGraphAuthorityIndexSnapshotRequest {
  const data = record(value);
  if (!data || !exactKeys(data, ['scope', 'deploymentBlockNumber', 'minThroughBlockNumber', 'maxThroughBlockNumber'])
    || typeof data.scope !== 'string' || data.scope.length === 0 || data.scope.length > 512
    || data.scope !== data.scope.trim()
    || Array.from(data.scope).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || !validBlock(data.deploymentBlockNumber)
    || !validBlock(data.minThroughBlockNumber)
    || !validBlock(data.maxThroughBlockNumber)
    || data.minThroughBlockNumber < data.deploymentBlockNumber
    || data.maxThroughBlockNumber < data.minThroughBlockNumber
    || data.maxThroughBlockNumber - data.minThroughBlockNumber > maxTailBlocks) {
    throw new Error('Invalid authority index snapshot request');
  }
  return Object.freeze({
    scope: data.scope,
    deploymentBlockNumber: data.deploymentBlockNumber,
    minThroughBlockNumber: data.minThroughBlockNumber,
    maxThroughBlockNumber: data.maxThroughBlockNumber,
  });
}

export function parseBounded(bytes: Uint8Array, limit: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) {
    throw new Error('Authority index snapshot wire size limit exceeded');
  }
  return JSON.parse(decoder.decode(bytes));
}

/** Keep the wire envelope exact; checkpoint schema and integrity belong to chain. */
export function hasSnapshotEnvelopeKeys(value: unknown): boolean {
  const envelope = record(value);
  return envelope !== undefined && exactKeys(envelope, ['version', 'scope', 'checkpoint']);
}

export type Status = 'not-ready' | 'invalid-request' | 'unavailable' | 'too-large' | 'busy' | 'above-range' | 'below-range';
export const STATUSES: ReadonlySet<string> = new Set<Status>([
  'not-ready', 'invalid-request', 'unavailable', 'too-large', 'busy', 'above-range', 'below-range',
]);
