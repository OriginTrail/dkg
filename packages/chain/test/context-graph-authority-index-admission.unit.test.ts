// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  classifyContextGraphAuthorityIndexAdmission,
  UNREAD_CONTEXT_GRAPH_AUTHORITY_INDEX_ANCHOR,
} from '../src/context-graph-authority-index-admission.js';
import { createContextGraphAuthorityIndexCheckpoint } from
  '../src/context-graph-authority-index-checkpoint.js';

const HASH_20 = `0x${'20'.repeat(32)}`;
const HASH_25 = `0x${'25'.repeat(32)}`;
const REPLACEMENT_HASH = `0x${'ff'.repeat(32)}`;

const checkpoint = createContextGraphAuthorityIndexCheckpoint({
  deploymentBlockNumber: 10,
  throughBlockNumber: 20,
  throughBlockHash: HASH_20,
}, []);

const record = Object.freeze({
  kind: 'checkpoint' as const,
  token: 7,
  checkpoint,
});

const input = (overrides: Record<string, unknown> = {}) => ({
  record,
  deploymentBlockNumber: 10,
  finalized: { number: 25, hash: HASH_25 },
  anchor: UNREAD_CONTEXT_GRAPH_AUTHORITY_INDEX_ANCHOR,
  ...overrides,
} as Parameters<typeof classifyContextGraphAuthorityIndexAdmission>[0]);

describe('Context Graph authority index checkpoint admission policy', () => {
  it('classifies missing, tombstone, and invalid durable rows without effects', () => {
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      record: { kind: 'missing', token: undefined },
    }))).toEqual({ kind: 'rebuild', reason: 'missing' });
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      record: { kind: 'tombstone', token: 8 },
    }))).toEqual({ kind: 'rebuild', reason: 'tombstone' });
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      record: { kind: 'invalid', token: 8 },
    }))).toEqual({ kind: 'invalidate', reason: 'invalid-checkpoint' });
  });

  it('requests only the anchor observation needed to accept a warm checkpoint', () => {
    expect(classifyContextGraphAuthorityIndexAdmission(input())).toEqual({
      kind: 'read-anchor',
      blockNumber: 20,
    });
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      anchor: { kind: 'available', hash: HASH_20 },
    }))).toEqual({ kind: 'accept', checkpoint });
  });

  it('keeps lagging and non-archive observations retryable without invalidation', () => {
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      finalized: { number: 19, hash: HASH_25 },
    }))).toEqual({
      kind: 'retry-provider',
      reason: 'finalized-behind',
      cursorBlockNumber: 20,
      finalizedBlockNumber: 19,
    });
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      anchor: { kind: 'unavailable' },
    }))).toEqual({
      kind: 'retry-provider',
      reason: 'anchor-unavailable',
      cursorBlockNumber: 20,
      finalizedBlockNumber: 25,
    });
  });

  it('invalidates only deployment changes and proven fork replacements', () => {
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      deploymentBlockNumber: 11,
    }))).toEqual({ kind: 'invalidate', reason: 'deployment-changed' });
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      anchor: { kind: 'available', hash: REPLACEMENT_HASH },
    }))).toEqual({ kind: 'invalidate', reason: 'anchor-replaced' });
    expect(classifyContextGraphAuthorityIndexAdmission(input({
      record: {
        ...record,
        checkpoint: createContextGraphAuthorityIndexCheckpoint({
          deploymentBlockNumber: 10,
          throughBlockNumber: 25,
          throughBlockHash: HASH_20,
        }, []),
      },
    }))).toEqual({ kind: 'invalidate', reason: 'anchor-replaced' });
  });
});
