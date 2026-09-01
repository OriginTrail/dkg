/**
 * W2 (#2435) — the drain's decision table, exhaustively.
 *
 * `planTransition` is the only place that decides whether a re-verification
 * intent is DONE. Getting one cell wrong is not a visible bug: the intent is
 * deleted, the drain reports success, and the node keeps serving the old root
 * — the original defect, now with a green counter in front of it. So every
 * (kind x item status x versionBlock relation) cell and every error class gets
 * its own row, with LITERAL expectations rather than a re-statement of the
 * implementation's own logic.
 */
import { describe, expect, it } from 'vitest';
import type { KnowledgeAssetRootMutationKindV1 } from '@origintrail-official/dkg-core';

import {
  VM_REVERIFY_FLAT_ATTEMPTS,
  VM_REVERIFY_FLAT_BACKOFF_MS,
  VM_REVERIFY_MAX_BACKOFF_MS,
  VM_REVERIFY_PARK_AFTER_MS,
  backoffMs,
  planTransition,
  type VmReverifyTransition,
} from '../src/vm-reverify-intents.js';
import {
  ContextGraphAssetFetchConflictError,
  ContextGraphAssetFetchValidationError,
  ExactAssetFetchLifecycleClosedError,
  type ContextGraphAssetFetchItemStatus,
} from '../src/sync/exact-asset-fetch.js';
import { ContextGraphNotFoundError } from '../src/dkg-agent-types.js';
import {
  VmReconcileQueueClosedError,
  VmReconcileUnavailableError,
} from '../src/vm-reconcile-service.js';

const OBSERVED_BLOCK = 1_000;
const NOW = 5_000_000;

/** Every kind whose repair direction is FORWARD (a version can be fetched). */
const FORWARD_KINDS: KnowledgeAssetRootMutationKindV1[] = [
  'lifecycle-update',
  'root-added',
  'roots-replaced',
];

type Relation = 'behind' | 'equal' | 'ahead';

const RELATION_BLOCK: Record<Relation, number> = {
  behind: OBSERVED_BLOCK - 1,
  equal: OBSERVED_BLOCK,
  ahead: OBSERVED_BLOCK + 1,
};

function plan(input: {
  kind: KnowledgeAssetRootMutationKindV1;
  status?: ContextGraphAssetFetchItemStatus;
  relation?: Relation;
  error?: unknown;
  attemptNumber?: number;
  firstAttemptAt?: number;
  now?: number;
  swmRecovery?: 'completed' | 'unavailable' | 'failed';
}): VmReverifyTransition {
  return planTransition({
    kind: input.kind,
    ...(input.status === undefined || input.relation === undefined
      ? {}
      : {
        item: {
          status: input.status,
          versionBlock: RELATION_BLOCK[input.relation],
        },
      }),
    ...(input.error === undefined ? {} : { error: input.error }),
    observedBlock: OBSERVED_BLOCK,
    attemptNumber: input.attemptNumber ?? 1,
    ...(input.firstAttemptAt === undefined ? {} : { firstAttemptAt: input.firstAttemptAt }),
    ...(input.swmRecovery === undefined
      ? {}
      : { swmRecovery: input.swmRecovery }),
    now: input.now ?? NOW,
  });
}

// ── (status x versionBlock relation) for every FORWARD kind ────────────────
// 4 statuses x 3 relations = 12 cells, each applied to 3 kinds = 36 assertions.
const FORWARD_CELLS: Array<{
  status: ContextGraphAssetFetchItemStatus;
  relation: Relation;
  expected: { action: string; reason: string };
}> = [
  { status: 'already-present', relation: 'behind', expected: { action: 'retry', reason: 'snapshot-behind-event' } },
  { status: 'already-present', relation: 'equal', expected: { action: 'resolve', reason: 'already-present' } },
  { status: 'already-present', relation: 'ahead', expected: { action: 'resolve', reason: 'already-present' } },

  { status: 'materialized', relation: 'behind', expected: { action: 'retry', reason: 'snapshot-behind-event' } },
  { status: 'materialized', relation: 'equal', expected: { action: 'resolve', reason: 'materialized' } },
  { status: 'materialized', relation: 'ahead', expected: { action: 'resolve', reason: 'materialized' } },

  { status: 'fetched', relation: 'behind', expected: { action: 'retry', reason: 'snapshot-behind-event' } },
  { status: 'fetched', relation: 'equal', expected: { action: 'resolve', reason: 'fetched' } },
  { status: 'fetched', relation: 'ahead', expected: { action: 'resolve', reason: 'fetched' } },

  // `unresolved` is decided BEFORE the block rule: no local copy exists to be
  // current, whatever block the chain view was read at.
  { status: 'unresolved', relation: 'behind', expected: { action: 'retry', reason: 'unresolved' } },
  { status: 'unresolved', relation: 'equal', expected: { action: 'retry', reason: 'unresolved' } },
  { status: 'unresolved', relation: 'ahead', expected: { action: 'retry', reason: 'unresolved' } },
];

// ── the same 12 cells for `root-removed` ──────────────────────────────────
// Only `unresolved` differs: there is no forward version to fetch, so the row
// stops instead of retrying forever against an unreachable-looking outcome.
const ROOT_REMOVED_CELLS: typeof FORWARD_CELLS = [
  { status: 'already-present', relation: 'behind', expected: { action: 'retry', reason: 'snapshot-behind-event' } },
  { status: 'already-present', relation: 'equal', expected: { action: 'resolve', reason: 'already-present' } },
  { status: 'already-present', relation: 'ahead', expected: { action: 'resolve', reason: 'already-present' } },

  { status: 'materialized', relation: 'behind', expected: { action: 'retry', reason: 'snapshot-behind-event' } },
  { status: 'materialized', relation: 'equal', expected: { action: 'resolve', reason: 'materialized' } },
  { status: 'materialized', relation: 'ahead', expected: { action: 'resolve', reason: 'materialized' } },

  { status: 'fetched', relation: 'behind', expected: { action: 'retry', reason: 'snapshot-behind-event' } },
  { status: 'fetched', relation: 'equal', expected: { action: 'resolve', reason: 'fetched' } },
  { status: 'fetched', relation: 'ahead', expected: { action: 'resolve', reason: 'fetched' } },

  { status: 'unresolved', relation: 'behind', expected: { action: 'abandon', reason: 'version-regression-unsupported' } },
  { status: 'unresolved', relation: 'equal', expected: { action: 'abandon', reason: 'version-regression-unsupported' } },
  { status: 'unresolved', relation: 'ahead', expected: { action: 'abandon', reason: 'version-regression-unsupported' } },
];

describe('planTransition — item outcomes, every (kind x status x versionBlock) cell', () => {
  for (const kind of FORWARD_KINDS) {
    for (const cell of FORWARD_CELLS) {
      it(`${kind} / ${cell.status} / versionBlock ${cell.relation} -> ${cell.expected.action}:${cell.expected.reason}`, () => {
        expect(plan({ kind, status: cell.status, relation: cell.relation }))
          .toMatchObject(cell.expected);
      });
    }
  }

  for (const cell of ROOT_REMOVED_CELLS) {
    it(`root-removed / ${cell.status} / versionBlock ${cell.relation} -> ${cell.expected.action}:${cell.expected.reason}`, () => {
      expect(plan({ kind: 'root-removed', status: cell.status, relation: cell.relation }))
        .toMatchObject(cell.expected);
    });
  }

  it('never resolves on a chain view read before the event, for any kind', () => {
    // The single property the whole design turns on, asserted once more as a
    // property rather than as a set of cells: a repair may only close an intent
    // on evidence that is at least as new as the event that raised it.
    const resolved: string[] = [];
    for (const kind of [...FORWARD_KINDS, 'root-removed' as const]) {
      for (const status of ['already-present', 'materialized', 'fetched'] as const) {
        const transition = plan({ kind, status, relation: 'behind' });
        if (transition.action === 'resolve') resolved.push(`${kind}/${status}`);
      }
    }
    expect(resolved, 'these cells resolved on evidence older than the event').toEqual([]);
  });

  it('leaves the row alone when the call produced neither an item nor an error', () => {
    expect(planTransition({
      kind: 'lifecycle-update',
      observedBlock: OBSERVED_BLOCK,
      attemptNumber: 1,
      now: NOW,
    })).toEqual({ action: 'leave', reason: 'no-result' });
  });
});

// ── error classification ──────────────────────────────────────────────────
const ERROR_CELLS: Array<{
  label: string;
  error: unknown;
  expected: { action: string; reason: string };
}> = [
  {
    label: 'conflict:snapshot-unavailable (an endpoint did not answer)',
    error: new ContextGraphAssetFetchConflictError('snapshot-unavailable', 'no coherent snapshot'),
    expected: { action: 'retry', reason: 'snapshot-unavailable' },
  },
  {
    label: 'conflict:invalid-evidence (chain answered with unusable data)',
    error: new ContextGraphAssetFetchConflictError('invalid-evidence', 'invalid version block'),
    expected: { action: 'retry', reason: 'invalid-evidence' },
  },
  {
    label: 'conflict:not-registered',
    error: new ContextGraphAssetFetchConflictError('not-registered', 'not registered'),
    expected: { action: 'abandon', reason: 'chain-identity-conflict' },
  },
  {
    label: 'conflict:no-committed-version',
    error: new ContextGraphAssetFetchConflictError('no-committed-version', 'rootCount 0'),
    expected: { action: 'abandon', reason: 'chain-identity-conflict' },
  },
  {
    label: 'conflict:binding-mismatch',
    error: new ContextGraphAssetFetchConflictError('binding-mismatch', 'wrong cg'),
    expected: { action: 'abandon', reason: 'chain-identity-conflict' },
  },
  {
    label: 'conflict:wrong-network',
    error: new ContextGraphAssetFetchConflictError('wrong-network', 'other chain'),
    expected: { action: 'abandon', reason: 'chain-identity-conflict' },
  },
  {
    label: 'validation error is OUR bug, not a network condition',
    error: new ContextGraphAssetFetchValidationError('bad uals'),
    expected: { action: 'abandon', reason: 'programmer-error' },
  },
  {
    label: 'context graph not held here right now — non-terminal',
    error: new ContextGraphNotFoundError('cg'),
    expected: { action: 'retry', reason: 'context-graph-not-held' },
  },
  {
    label: 'reconcile queue closed (shutdown)',
    error: new VmReconcileQueueClosedError(),
    expected: { action: 'leave', reason: 'lifecycle-closed' },
  },
  {
    label: 'reconcile unavailable (adapter cannot serve it)',
    error: new VmReconcileUnavailableError(),
    expected: { action: 'leave', reason: 'lifecycle-closed' },
  },
  {
    label: 'exact-fetch lifecycle closed',
    error: new ExactAssetFetchLifecycleClosedError(),
    expected: { action: 'leave', reason: 'lifecycle-closed' },
  },
  {
    label: 'abort',
    error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    expected: { action: 'leave', reason: 'lifecycle-closed' },
  },
  {
    label: 'anything else — transient until proven otherwise, but named',
    error: new Error('socket hang up'),
    expected: { action: 'retry', reason: 'unexpected-error' },
  },
];

describe('planTransition — error classification', () => {
  for (const cell of ERROR_CELLS) {
    it(`${cell.label} -> ${cell.expected.action}:${cell.expected.reason}`, () => {
      expect(plan({ kind: 'lifecycle-update', error: cell.error }))
        .toMatchObject(cell.expected);
    });
  }

  it('classifies the same way for every mutation kind', () => {
    // `root-removed` short-circuits only on an UNRESOLVED item. A thrown call
    // says nothing about direction, so the error table must not change.
    for (const cell of ERROR_CELLS) {
      expect(
        plan({ kind: 'root-removed', error: cell.error }),
        `root-removed changed the classification of ${cell.label}`,
      ).toMatchObject(cell.expected);
    }
  });

  it('an abandon carries a reason the store accepts, never a free-form string', () => {
    const storeReasons = new Set([
      'version-regression-unsupported',
      'chain-identity-conflict',
      'programmer-error',
      'no-peer-has-version',
    ]);
    for (const cell of [...ERROR_CELLS]) {
      const transition = plan({ kind: 'lifecycle-update', error: cell.error });
      if (transition.action !== 'abandon') continue;
      expect(storeReasons.has(transition.reason), `${cell.label} -> ${transition.reason}`).toBe(true);
    }
  });
});

// ── the ladders ───────────────────────────────────────────────────────────
describe('backoffMs — the split retry ladder', () => {
  it('holds evidence-unavailable flat for the first attempts', () => {
    for (let attempt = 1; attempt <= VM_REVERIFY_FLAT_ATTEMPTS; attempt += 1) {
      expect(backoffMs('evidence-unavailable', attempt)).toBe(VM_REVERIFY_FLAT_BACKOFF_MS);
    }
  });

  it('does NOT stay flat forever — a sustained outage backs off', () => {
    // 2,880 pinned five-call chain views per intent per day is not a retry
    // policy, it is an outage amplifier.
    expect(backoffMs('evidence-unavailable', VM_REVERIFY_FLAT_ATTEMPTS + 1)).toBe(30_000);
    expect(backoffMs('evidence-unavailable', VM_REVERIFY_FLAT_ATTEMPTS + 2)).toBe(60_000);
    expect(backoffMs('evidence-unavailable', VM_REVERIFY_FLAT_ATTEMPTS + 3)).toBe(120_000);
    expect(backoffMs('evidence-unavailable', VM_REVERIFY_FLAT_ATTEMPTS + 20))
      .toBe(VM_REVERIFY_MAX_BACKOFF_MS);
  });

  it('backs unresolved off exponentially from 30 s to 60 min', () => {
    expect(backoffMs('unresolved', 1)).toBe(30_000);
    expect(backoffMs('unresolved', 2)).toBe(60_000);
    expect(backoffMs('unresolved', 3)).toBe(120_000);
    expect(backoffMs('unresolved', 4)).toBe(240_000);
    expect(backoffMs('unresolved', 7)).toBe(1_920_000);
    expect(backoffMs('unresolved', 8)).toBe(VM_REVERIFY_MAX_BACKOFF_MS);
    expect(backoffMs('unresolved', 99)).toBe(VM_REVERIFY_MAX_BACKOFF_MS);
  });

  it('is defensive about a non-positive attempt number', () => {
    expect(backoffMs('unresolved', 0)).toBe(30_000);
    expect(backoffMs('unresolved', -5)).toBe(30_000);
  });

  it('the two ladders are actually different (the split is not decorative)', () => {
    const flat = [1, 2, 3, 4, 5].map((n) => backoffMs('evidence-unavailable', n));
    const exponential = [1, 2, 3, 4, 5].map((n) => backoffMs('unresolved', n));
    expect(flat).not.toEqual(exponential);
  });

  it('a retry transition carries the delay of its own ladder', () => {
    const behind = plan({
      kind: 'lifecycle-update', status: 'already-present', relation: 'behind', attemptNumber: 3,
    });
    expect(behind).toMatchObject({
      action: 'retry',
      reason: 'snapshot-behind-event',
      outcomeClass: 'evidence-unavailable',
      delayMs: VM_REVERIFY_FLAT_BACKOFF_MS,
    });

    const unresolved = plan({
      kind: 'lifecycle-update', status: 'unresolved', relation: 'equal', attemptNumber: 3,
    });
    expect(unresolved).toMatchObject({
      action: 'retry',
      reason: 'unresolved',
      outcomeClass: 'unresolved',
      delayMs: 120_000,
    });
  });
});

// ── the park boundary ─────────────────────────────────────────────────────
describe('planTransition — the 24 h park', () => {
  const firstAttemptAt = 1_000_000;

  it('keeps retrying right up to the boundary and parks exactly at it', () => {
    const justBefore = plan({
      kind: 'lifecycle-update',
      status: 'unresolved',
      relation: 'equal',
      firstAttemptAt,
      now: firstAttemptAt + VM_REVERIFY_PARK_AFTER_MS - 1,
    });
    expect(justBefore).toMatchObject({ action: 'retry', reason: 'unresolved' });

    const atBoundary = plan({
      kind: 'lifecycle-update',
      status: 'unresolved',
      relation: 'equal',
      firstAttemptAt,
      now: firstAttemptAt + VM_REVERIFY_PARK_AFTER_MS,
    });
    expect(atBoundary).toEqual({ action: 'abandon', reason: 'no-peer-has-version' });
  });

  it('cannot park a row that has never attempted anything', () => {
    // `firstAttemptAt` is absent until the first attempt is recorded. Treating
    // absent as 0 would park every brand-new intent instantly.
    expect(plan({
      kind: 'lifecycle-update',
      status: 'unresolved',
      relation: 'equal',
      now: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ action: 'retry', reason: 'unresolved' });
  });

  it('does not park an evidence-unavailable row: that is an endpoint problem, not a peer one', () => {
    // Parking here would report `no-peer-has-version` about a node that never
    // got far enough to ask a peer — and would hide a broken RPC pool behind a
    // plausible-looking abandon reason. The runbook signal for this case is a
    // climbing `retried{reason=snapshot-*}`, which requires the row to stay live.
    expect(plan({
      kind: 'lifecycle-update',
      status: 'already-present',
      relation: 'behind',
      firstAttemptAt,
      now: firstAttemptAt + VM_REVERIFY_PARK_AFTER_MS * 10,
    })).toMatchObject({ action: 'retry', reason: 'snapshot-behind-event' });
  });

  it('DEFERS instead of parking when the durable plane that carries SWM is off', () => {
    // ADR-W2R-10. The exact fetch carries no SWM, so with the durable plane off
    // there is NO route by which this item could ever resolve. Counting it down
    // to `no-peer-has-version` would blame the network for a local switch, and
    // would bury the work under a terminal state an operator has no reason to
    // go looking for once they turn the plane back on.
    const wayPastTheBudget = {
      kind: 'lifecycle-update' as const,
      status: 'unresolved' as const,
      relation: 'equal' as const,
      firstAttemptAt,
      now: firstAttemptAt + VM_REVERIFY_PARK_AFTER_MS * 10,
    };

    // A FAILED recovery (review r3) is an infrastructure outcome: it retries
    // on the evidence ladder and must never reach the park, however old the
    // budget is — peer exhaustion was never established.
    expect(plan({ ...wayPastTheBudget, swmRecovery: 'failed' })).toMatchObject({
      action: 'retry',
      reason: 'swm-recovery-failed',
      outcomeClass: 'evidence-unavailable',
    });
    expect(plan({ ...wayPastTheBudget, swmRecovery: 'unavailable' })).toMatchObject({
      action: 'retry',
      reason: 'durable-sync-disabled',
      outcomeClass: 'evidence-unavailable',
    });

    // Same inputs, recovery AVAILABLE: the park is reached. Measuring both
    // polarities is what proves the new branch is the thing making the
    // difference rather than the park having quietly stopped working.
    expect(plan({ ...wayPastTheBudget, swmRecovery: 'completed' }))
      .toEqual({ action: 'abandon', reason: 'no-peer-has-version' });
  });

  it('a root REMOVAL still abandons even with the durable plane off', () => {
    // Ordering: an unrepairable direction outranks an unavailable mechanism.
    expect(plan({
      kind: 'root-removed',
      status: 'unresolved',
      relation: 'equal',
      firstAttemptAt,
      now: firstAttemptAt + VM_REVERIFY_PARK_AFTER_MS,
      swmRecovery: 'unavailable',
    })).toEqual({ action: 'abandon', reason: 'version-regression-unsupported' });
  });

  it('root-removed abandons for its own reason, not the park reason', () => {
    expect(plan({
      kind: 'root-removed',
      status: 'unresolved',
      relation: 'equal',
      firstAttemptAt,
      now: firstAttemptAt + VM_REVERIFY_PARK_AFTER_MS * 10,
    })).toEqual({ action: 'abandon', reason: 'version-regression-unsupported' });
  });
});
