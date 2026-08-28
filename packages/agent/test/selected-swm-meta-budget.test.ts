import { describe, expect, it } from 'vitest';
import {
  createSelectedSwmMetaRetentionBudget,
} from '../src/sync/selected-swm-meta-budget.js';

describe('selected SWM metadata retention budget', () => {
  it('accounts retained prefixes across Context Graphs and overlapping invocations', () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 3,
      maxBytesEstimate: 300,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const first = budget.lease();
    const second = budget.lease();

    first.replace(2, 200);
    const remaining = second.reserve();
    expect(remaining).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
    }));
    remaining.release();
    expect(() => second.replace(2, 200)).toThrowError(expect.objectContaining({
      code: 'SELECTED_SWM_META_RETENTION_LIMIT',
      dimension: 'rows',
      actual: 4,
      limit: 3,
    }));

    second.replace(1, 100);
    const exhausted = second.reserve();
    expect(exhausted).toEqual(expect.objectContaining({
      maxRows: 0,
      maxBytesEstimate: 0,
    }));
    exhausted.release();
    first.release();
    const restored = second.reserve();
    expect(restored).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
    }));
    restored.release();
    second.release();
  });

  it('atomically replaces a restarted generation instead of double-counting it', () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 10,
      maxBytesEstimate: 1_000,
      maxPrefixRows: 10,
      maxPrefixBytesEstimate: 1_000,
    });
    const lease = budget.lease();

    lease.replace(8, 800);
    // The conservative pre-fetch allowance is append-only.
    const remaining = lease.reserve();
    expect(remaining).toEqual(expect.objectContaining({
      maxRows: 2,
      maxBytesEstimate: 200,
    }));
    remaining.release();
    // Once the responder restart is known, replacement frees the old prefix.
    lease.replace(2, 200);
    const restarted = lease.reserve();
    expect(restarted).toEqual(expect.objectContaining({
      maxRows: 8,
      maxBytesEstimate: 800,
    }));
    restarted.release();
    lease.release();
  });

  it('reserves global capacity before overlapping fetches start', () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 3,
      maxBytesEstimate: 300,
      maxPrefixRows: 3,
      maxPrefixBytesEstimate: 300,
    });
    const first = budget.lease();
    const second = budget.lease();

    const firstFetch = first.reserve();
    expect(firstFetch).toEqual(expect.objectContaining({
      maxRows: 3,
      maxBytesEstimate: 300,
    }));
    const concurrentFetch = second.reserve();
    expect(concurrentFetch).toEqual(expect.objectContaining({
      maxRows: 0,
      maxBytesEstimate: 0,
    }));

    firstFetch.commitReplace(2, 200);
    concurrentFetch.release();
    const afterCommit = second.reserve();
    expect(afterCommit).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
    }));
    afterCommit.release();
    first.release();
    second.release();
  });
});
