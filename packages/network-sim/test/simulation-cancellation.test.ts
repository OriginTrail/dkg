import { describe, expect, it } from 'vitest';
import { normalizeSimulationCancellation as normalize } from '../src/simulation-cancellation';
import type { ScopedDoneEvent } from '../src/simulation-protocol';

const runId = 'expected-run';
const snapshot: ScopedDoneEvent = { type: 'done', runId, total: 2, completed: 1, errors: 0, elapsedMs: 100,
  byOp: { query: { ok: 1, fail: 0, timeouts: 0, totalMs: 10, allMs: 10, phaseTotals: { query: 10 }, phaseCounts: { query: 1 } } } };

describe('scoped cancellation transport boundary', () => {
  it('normalizes all supported scoped outcomes without inventing terminal results', () => {
    expect(normalize({ stopped: true, runId, snapshot }, runId)).toEqual({ kind: 'completed', runId, snapshot });
    expect(normalize({ stopped: true, runId }, runId)).toEqual({ kind: 'cancelled', runId });
    expect(normalize({ stopped: false, runId, retryAfterMs: 100, reason: 'capacity full' }, runId))
      .toEqual({ kind: 'retry', runId, retryAfterMs: 100, reason: 'capacity full' });
    expect(normalize({ stopped: false, runId, reason: 'unconfirmed' }, runId)).toMatchObject({ kind: 'unconfirmed', runId });
  });
  it.each([
    null, [], { stopped: true }, { stopped: true, runId: 'foreign' },
    { stopped: true, runId, retryAfterMs: 100 }, { stopped: true, runId, reason: 'ambiguous' },
    { stopped: false, runId, snapshot }, { stopped: 'true', runId },
    { stopped: false, runId, retryAfterMs: 0 }, { stopped: false, runId, retryAfterMs: Number.NaN },
    { stopped: true, runId, snapshot: { ...snapshot, runId: 'foreign' } },
    { stopped: true, runId, snapshot: { ...snapshot, total: -1 } },
    { stopped: true, runId, snapshot: { ...snapshot, byOp: null } },
    { stopped: true, runId, snapshot: { ...snapshot, byOp: { query: { ...snapshot.byOp.query, phaseTotals: { query: 'wrong' } } } } },
    { stopped: true, runId, snapshot: { ...snapshot, byOp: { query: { ...snapshot.byOp.query, phaseCounts: null } } } },
  ])('refuses invalid, contradictory, legacy or foreign wire data: %j', value => {
    expect(normalize(value, runId)).toMatchObject({ kind: 'unconfirmed', runId });
  });
});
