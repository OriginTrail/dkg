// SPDX-License-Identifier: Apache-2.0

import type { ChainReadOptions } from './chain-adapter.js';
import {
  normalizeContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexCheckpoint,
} from './context-graph-authority-index-checkpoint.js';

export const CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** Includes room for the 50-block durable holdback and ordinary refresh/head skew. */
export const CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS = 200;
export const CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS = 30_000;

export class ContextGraphAuthorityIndexSnapshotExportError extends Error {
  override readonly name = 'ContextGraphAuthorityIndexSnapshotExportError';

  constructor(readonly status: 'too-large' | 'above-range' | 'below-range' | 'unavailable') {
    super(`Context Graph authority index snapshot ${status}`);
  }
}

/** A later caller may retry; switching RPC providers must not restart peer walks. */
export class ContextGraphAuthorityIndexBootstrapUnavailableError extends AggregateError {
  override readonly name = 'ContextGraphAuthorityIndexBootstrapUnavailableError';
  readonly code = 'AUTHORITY_INDEX_BOOTSTRAP_UNAVAILABLE';
  readonly retryAfterMs = 5_000;

  constructor(cause: unknown) {
    super([cause], `Context Graph authority index snapshot bootstrap unavailable: ${
      cause instanceof Error ? cause.message : String(cause)
    }`, { cause });
  }
}

export interface ContextGraphAuthorityIndexSnapshotRequest {
  readonly scope: string;
  readonly deploymentBlockNumber: number;
  readonly minThroughBlockNumber: number;
  readonly maxThroughBlockNumber: number;
}

/** Trusted core transport envelope; the checkpoint hash is not a chain proof. */
export interface ContextGraphAuthorityIndexSnapshot {
  readonly version: 1;
  readonly scope: string;
  readonly checkpoint: unknown;
}

export interface ContextGraphAuthorityIndexBootstrap {
  /** Stable digest of the configured trusted identities, isolates local persistence. */
  readonly trustDomain: string;
  readonly maxTailBlocks: number;
  /** Transport must authenticate the explicitly configured trusted core. */
  readonly fetchSnapshot: (
    request: ContextGraphAuthorityIndexSnapshotRequest,
    signal: AbortSignal,
    validateSnapshot: (snapshot: unknown, signal?: AbortSignal) => Promise<void>,
  ) => Promise<unknown>;
}

export interface ContextGraphAuthorityIndexSnapshots {
  open(): void;
  close(): Promise<void>;
  /** Cached durable state only: serving never starts a historical scan. */
  exportSnapshot(
    request: ContextGraphAuthorityIndexSnapshotRequest,
  ): Promise<ContextGraphAuthorityIndexSnapshot | null>;
  refresh(options?: ChainReadOptions): Promise<void>;
}

export function isContextGraphAuthorityIndexSnapshotRequest(
  value: ContextGraphAuthorityIndexSnapshotRequest,
): boolean {
  return value !== null && typeof value === 'object'
    && typeof value.scope === 'string' && value.scope.length > 0 && value.scope.length <= 1024
    && [value.deploymentBlockNumber, value.minThroughBlockNumber, value.maxThroughBlockNumber]
      .every((block) => Number.isSafeInteger(block) && block >= 0)
    && value.deploymentBlockNumber <= value.minThroughBlockNumber
    && value.minThroughBlockNumber <= value.maxThroughBlockNumber;
}

export function authorityIndexSnapshotWithinSizeLimit(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined
      && new TextEncoder().encode(encoded).byteLength <= CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Structural integrity and requested prefix bounds, before chain anchoring. */
export function decodeContextGraphAuthorityIndexSnapshot(
  value: unknown,
  request: ContextGraphAuthorityIndexSnapshotRequest,
): ContextGraphAuthorityIndexCheckpoint | undefined {
  if (!isContextGraphAuthorityIndexSnapshotRequest(request)
    || value === null || typeof value !== 'object' || Array.isArray(value)
    || !authorityIndexSnapshotWithinSizeLimit(value)) return undefined;
  const envelope = value as Partial<ContextGraphAuthorityIndexSnapshot>;
  if (envelope.version !== 1 || envelope.scope !== request.scope) return undefined;
  const checkpoint = normalizeContextGraphAuthorityIndexCheckpoint(envelope.checkpoint);
  if (checkpoint === undefined
    || checkpoint.cursor.deploymentBlockNumber !== request.deploymentBlockNumber
    || checkpoint.cursor.throughBlockNumber < request.minThroughBlockNumber
    || checkpoint.cursor.throughBlockNumber > request.maxThroughBlockNumber) return undefined;
  return checkpoint;
}

export function normalizeContextGraphAuthorityIndexSnapshot(
  value: unknown,
  request: ContextGraphAuthorityIndexSnapshotRequest,
): ContextGraphAuthorityIndexSnapshot | undefined {
  const checkpoint = decodeContextGraphAuthorityIndexSnapshot(value, request);
  return checkpoint === undefined ? undefined
    : Object.freeze({ version: 1 as const, scope: request.scope, checkpoint });
}
