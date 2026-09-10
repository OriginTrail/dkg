// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphAuthorityIndexCheckpoint } from
  './context-graph-authority-index-checkpoint.js';
import type { ContextGraphAuthorityIndexRepositoryRecord } from
  './context-graph-authority-index-repository.js';

export type ContextGraphAuthorityIndexAnchorObservation =
  | Readonly<{ kind: 'unread' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'available'; hash: string }>;

export const UNREAD_CONTEXT_GRAPH_AUTHORITY_INDEX_ANCHOR:
Readonly<ContextGraphAuthorityIndexAnchorObservation> = Object.freeze({ kind: 'unread' });

export type ContextGraphAuthorityIndexAdmissionAction =
  | Readonly<{
      kind: 'accept';
      checkpoint: ContextGraphAuthorityIndexCheckpoint;
    }>
  | Readonly<{
      kind: 'rebuild';
      reason: 'missing' | 'tombstone';
    }>
  | Readonly<{
      kind: 'read-anchor';
      blockNumber: number;
    }>
  | Readonly<{
      kind: 'retry-provider';
      reason: 'finalized-behind' | 'anchor-unavailable';
      cursorBlockNumber: number;
      finalizedBlockNumber: number;
    }>
  | Readonly<{
      kind: 'invalidate';
      reason: 'invalid-checkpoint' | 'deployment-changed' | 'anchor-replaced';
    }>;

export interface ContextGraphAuthorityIndexAdmissionInput {
  readonly record: ContextGraphAuthorityIndexRepositoryRecord;
  readonly deploymentBlockNumber: number;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly anchor: ContextGraphAuthorityIndexAnchorObservation;
}

/**
 * Pure admission policy for one durable authority-index observation.
 *
 * The result names exactly one effect for the bounded driver to perform. It
 * never reads RPC, decodes persistence, mutates cache state, or performs CAS.
 */
export function classifyContextGraphAuthorityIndexAdmission(
  input: Readonly<ContextGraphAuthorityIndexAdmissionInput>,
): ContextGraphAuthorityIndexAdmissionAction {
  const { record, deploymentBlockNumber, finalized, anchor } = input;
  if (record.kind === 'missing' || record.kind === 'tombstone') {
    return Object.freeze({ kind: 'rebuild', reason: record.kind });
  }
  if (record.kind === 'invalid') {
    return Object.freeze({ kind: 'invalidate', reason: 'invalid-checkpoint' });
  }

  const checkpoint = record.checkpoint;
  if (checkpoint.cursor.deploymentBlockNumber !== deploymentBlockNumber) {
    return Object.freeze({ kind: 'invalidate', reason: 'deployment-changed' });
  }
  if (checkpoint.cursor.throughBlockNumber > finalized.number) {
    return Object.freeze({
      kind: 'retry-provider',
      reason: 'finalized-behind',
      cursorBlockNumber: checkpoint.cursor.throughBlockNumber,
      finalizedBlockNumber: finalized.number,
    });
  }

  if (checkpoint.cursor.throughBlockNumber === finalized.number) {
    return checkpoint.cursor.throughBlockHash === finalized.hash
      ? Object.freeze({ kind: 'accept', checkpoint })
      : Object.freeze({ kind: 'invalidate', reason: 'anchor-replaced' });
  }
  if (anchor.kind === 'unread') {
    return Object.freeze({
      kind: 'read-anchor',
      blockNumber: checkpoint.cursor.throughBlockNumber,
    });
  }
  if (anchor.kind === 'unavailable') {
    return Object.freeze({
      kind: 'retry-provider',
      reason: 'anchor-unavailable',
      cursorBlockNumber: checkpoint.cursor.throughBlockNumber,
      finalizedBlockNumber: finalized.number,
    });
  }
  return anchor.hash === checkpoint.cursor.throughBlockHash
    ? Object.freeze({ kind: 'accept', checkpoint })
    : Object.freeze({ kind: 'invalidate', reason: 'anchor-replaced' });
}
