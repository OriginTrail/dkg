import type { StatementSync } from 'node:sqlite';

import {
  assertCanonicalDeterministicUalV1,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  compareSwmAuthorInventoryRowsV1,
  computeSwmAuthorInventoryScopeDigestV1,
  deriveSwmAuthorInventoryScopeFromHeadV1,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  type Digest32V1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';

import {
  isSwmAuthorInventoryErrorV1,
  type SwmAuthorInventoryCasResultV1,
  type SwmAuthorInventoryErrorCodeV1,
} from './swm-author-inventory-contracts.js';
import type {
  EncodedSwmAuthorInventoryKeyV1,
  PreparedSwmAuthorInventoryCommitV1,
} from './swm-author-inventory-commit-plan.js';
import {
  requireAppliedSwmAuthorInventoryMutationV1,
  SwmAuthorInventoryMutationNoopErrorV1,
} from './swm-author-inventory-mutation.js';
import {
  sqlBlobToDecimalU64V1,
  sqlBlobToDigest32V1,
  sqlBlobToEvmAddressV1,
  nullableSqlBlobsEqualV1,
  sqlBlobsEqualV1,
} from './scalars.js';
import { INVENTORY_V1_STATEMENT_SQL } from './statements.js';
import {
  assertBoundedSqlBlobV1,
  decodeStoredSwmAuthorInventoryRowV1,
  swmAuthorHeadParametersV1,
  swmAuthorKeyParametersV1,
  swmAuthorRowParametersV1,
  type SqlRowV1,
} from './swm-author-inventory-sql-codec.js';

type SwmInventoryErrorCodeV1 = SwmAuthorInventoryErrorCodeV1;

export interface SwmAuthorInventoryPersistenceHostV1 {
  readonly prepare: (sql: string) => StatementSync;
  readonly statement: <T>(operation: () => T) => T;
  readonly error: (
    code: SwmInventoryErrorCodeV1,
    message: string,
    options?: ErrorOptions,
  ) => Error;
}

export type SwmAuthorInventoryCommitResolutionV1 = 'committed' | 'not-committed';

interface StoredSwmAuthorInventoryCommitV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  readonly expectedHead: Uint8Array | null;
  readonly mutationKind: 'upsert' | 'remove';
  readonly mutationKaUal: string;
}

type SwmAuthorInventoryCommitPlanV1 =
  | Readonly<{
      state: 'committed';
      current: StoredSwmAuthorInventoryCommitV1;
    }>
  | Readonly<{ state: 'not-committed' }>
  | Readonly<{
      state: 'conflict';
      actual: Digest32V1 | null;
      expected: Digest32V1 | null;
      reason: 'predecessor' | 'same-head-state' | 'same-head-replay';
    }>
  | Readonly<{
      state: 'apply-writes';
      current: StoredSwmAuthorInventoryCommitV1 | null;
    }>;

/** Pure, shared state machine for normal apply and indeterminate-COMMIT recovery. */
function planSwmAuthorInventoryCommitV1(
  current: StoredSwmAuthorInventoryCommitV1 | null,
  next: PreparedSwmAuthorInventoryCommitV1,
  phase: 'apply' | 'resolve',
): SwmAuthorInventoryCommitPlanV1 {
  const actual = (
    current?.snapshot.head.objectDigest as Digest32V1 | undefined
  ) ?? null;
  const expected = next.expectedHead === null ? null : sqlBlobToDigest32V1(next.expectedHead);
  if (actual === next.snapshot.head.objectDigest && current !== null) {
    if (!swmAuthorInventorySnapshotsEqualV1(current.snapshot, next.snapshot)) {
      return Object.freeze({
        state: 'conflict' as const,
        actual,
        expected,
        reason: 'same-head-state' as const,
      });
    }
    if (!swmAuthorInventoryReplayEvidenceEqualV1(current, next)) {
      return Object.freeze({
        state: 'conflict' as const,
        actual,
        expected,
        reason: 'same-head-replay' as const,
      });
    }
    return Object.freeze({ state: 'committed' as const, current });
  }
  if (actual !== expected) {
    return Object.freeze({
      state: 'conflict' as const,
      actual,
      expected,
      reason: 'predecessor' as const,
    });
  }
  return phase === 'apply'
    ? Object.freeze({ state: 'apply-writes' as const, current })
    : Object.freeze({ state: 'not-committed' as const });
}

/**
 * Connection-bound SWM persistence store. Commit planning, canonical mutation
 * semantics, and SQL row encoding live behind focused sibling modules.
 * Transaction ownership remains in CandidateInventoryV1.
 *
 * @internal
 */
export class SwmAuthorInventoryPersistenceV1 {
  constructor(private readonly host: SwmAuthorInventoryPersistenceHostV1) {}

  read(key: EncodedSwmAuthorInventoryKeyV1): SwmAuthorInventorySnapshotV1 | null {
    return this.readStored(key)?.snapshot ?? null;
  }

  private readStored(
    key: EncodedSwmAuthorInventoryKeyV1,
  ): StoredSwmAuthorInventoryCommitV1 | null {
    const headQuery = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.getSwmAuthorHead);
    const headRow = this.host.statement(() => headQuery.get({
      scope: key.scope,
      author: key.author,
    }) as SqlRowV1 | undefined);
    if (headRow === undefined) return null;
    const rowsQuery = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.getSwmAuthorRows);
    const storedRows = this.host.statement(() => rowsQuery.all({
      scope: key.scope,
      author: key.author,
    }) as SqlRowV1[]);
    try {
      const envelopeBytes = assertBoundedSqlBlobV1(
        headRow.signed_head_envelope,
        1,
        4 * 1024,
        'stored SWM author inventory head envelope',
      );
      const head = parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1(envelopeBytes);
      const scope = deriveSwmAuthorInventoryScopeFromHeadV1(head.payload);
      if (
        computeSwmAuthorInventoryScopeDigestV1(scope) !== sqlBlobToDigest32V1(key.scope)
        || head.payload.authorAddress !== sqlBlobToEvmAddressV1(key.author)
        || head.objectDigest !== sqlBlobToDigest32V1(headRow.current_head_digest)
        || head.payload.version !== sqlBlobToDecimalU64V1(headRow.inventory_version_u64be)
        || head.payload.totalRows !== sqlBlobToDecimalU64V1(headRow.total_rows_u64be)
        || head.payload.rowsDigest !== sqlBlobToDigest32V1(headRow.rows_digest)
      ) {
        throw new Error('stored head columns do not match the signed envelope');
      }
      const rows = Object.freeze(
        storedRows
          .map(decodeStoredSwmAuthorInventoryRowV1)
          .sort(compareSwmAuthorInventoryRowsV1),
      );
      const snapshot = Object.freeze({ head, rows });
      assertSwmAuthorInventorySnapshotBindingV1(snapshot);
      const expectedHead = headRow.expected_head_digest === null
        ? null
        : assertBoundedSqlBlobV1(
          headRow.expected_head_digest,
          32,
          32,
          'stored expected head',
        );
      const mutationKind = headRow.replay_mutation_kind;
      if (mutationKind !== 'upsert' && mutationKind !== 'remove') {
        throw new Error('stored replay mutation kind is invalid');
      }
      const mutationKaUal = assertCanonicalDeterministicUalV1(
        headRow.replay_mutation_ka_ual,
      ).ual;
      if (
        (expectedHead === null ? null : sqlBlobToDigest32V1(expectedHead))
        !== head.payload.previousHeadDigest
      ) {
        throw new Error('stored replay predecessor does not match the signed head');
      }
      return Object.freeze({ snapshot, expectedHead, mutationKind, mutationKaUal });
    } catch (cause) {
      if (isSwmAuthorInventoryErrorV1(cause, 'swm-inventory-database-corrupt')) throw cause;
      throw this.host.error(
        'swm-inventory-database-corrupt',
        'stored SWM author inventory is not canonical or internally bound',
        { cause },
      );
    }
  }

  apply(next: PreparedSwmAuthorInventoryCommitV1): SwmAuthorInventoryCasResultV1 {
    const plan = planSwmAuthorInventoryCommitV1(this.readStored(next), next, 'apply');
    if (plan.state === 'committed') {
      return Object.freeze({ status: 'existing' as const, snapshot: plan.current.snapshot });
    }
    if (plan.state === 'conflict') {
      if (plan.reason === 'same-head-state') {
        throw this.host.error(
          'swm-inventory-database-corrupt',
          'one SWM inventory head digest resolved to different exact state',
        );
      }
      if (plan.reason === 'same-head-replay') {
        throw this.host.error(
          'swm-inventory-input',
          'already-current SWM inventory was not produced by the exact requested CAS mutation',
        );
      }
      throw this.conflict(plan.actual, plan.expected);
    }
    if (plan.state !== 'apply-writes') {
      throw this.host.error(
        'swm-inventory-database-corrupt',
        'normal SWM inventory apply resolved as not committed without a write plan',
      );
    }
    const current = plan.current;
    this.assertMutationTransition(current?.snapshot ?? null, next);

    const headParameters = swmAuthorHeadParametersV1(next);
    if (current === null) {
      const insert = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.insertSwmAuthorHead);
      const result = this.host.statement(() => insert.run(headParameters));
      if (Number(result.changes) !== 1) {
        throw this.host.error(
          'swm-inventory-database-corrupt',
          'SWM author inventory initialization did not insert exactly one head',
        );
      }
    } else {
      const update = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.updateSwmAuthorHeadCas);
      const result = this.host.statement(() => update.run({
        ...headParameters,
        expectedHead: next.expectedHead,
      }));
      if (Number(result.changes) !== 1) {
        throw this.conflict(
          current.snapshot.head.objectDigest as Digest32V1,
          next.expectedHead === null ? null : sqlBlobToDigest32V1(next.expectedHead),
        );
      }
    }

    const mutation = next.mutation;
    if (mutation.kind === 'upsert') {
      const upsert = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.upsertSwmAuthorRow);
      const result = this.host.statement(() => upsert.run({
        ...swmAuthorKeyParametersV1(next),
        ...swmAuthorRowParametersV1(mutation.row),
      }));
      if (Number(result.changes) !== 1) {
        throw this.host.error(
          'swm-inventory-database-corrupt',
          'SWM author inventory upsert did not mutate exactly one row',
        );
      }
    } else {
      const remove = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.deleteSwmAuthorRow);
      const result = this.host.statement(() => remove.run({
        ...swmAuthorKeyParametersV1(next),
        kaUal: mutation.kaUal,
      }));
      if (Number(result.changes) !== 1) {
        throw this.host.error(
          'swm-inventory-input',
          'SWM author inventory removal target is absent',
        );
      }
    }

    const committed = planSwmAuthorInventoryCommitV1(
      this.readStored(next),
      next,
      'resolve',
    );
    if (committed.state !== 'committed') {
      throw this.host.error(
        'swm-inventory-database-corrupt',
        'SWM author inventory write did not exact-read as the requested next state',
      );
    }
    return Object.freeze({
      status: 'applied' as const,
      snapshot: committed.current.snapshot,
    });
  }

  resolve(next: PreparedSwmAuthorInventoryCommitV1): SwmAuthorInventoryCommitResolutionV1 {
    const plan = planSwmAuthorInventoryCommitV1(this.readStored(next), next, 'resolve');
    if (plan.state === 'committed') return 'committed';
    if (plan.state === 'not-committed') return 'not-committed';
    if (plan.state === 'conflict') throw this.conflict(plan.actual, plan.expected);
    throw this.host.error(
      'swm-inventory-database-corrupt',
      'indeterminate SWM inventory resolution produced an apply-only write plan',
    );
  }

  private assertMutationTransition(
    current: SwmAuthorInventorySnapshotV1 | null,
    next: PreparedSwmAuthorInventoryCommitV1,
  ): void {
    const nextHead = next.snapshot.head.payload;
    if (current === null) {
      if (nextHead.version !== '0' || nextHead.previousHeadDigest !== null) {
        throw this.host.error(
          'swm-inventory-input',
          'SWM author inventory initialization requires version 0 with no predecessor',
        );
      }
    } else if (
      BigInt(nextHead.version) !== BigInt(current.head.payload.version) + 1n
      || nextHead.previousHeadDigest !== current.head.objectDigest
    ) {
      throw this.host.error(
        'swm-inventory-input',
        'SWM author inventory successor must increment version and bind the exact predecessor',
      );
    }
    let rows;
    try {
      rows = requireAppliedSwmAuthorInventoryMutationV1(
        current?.rows ?? [],
        next.mutation,
      );
    } catch (cause) {
      if (cause instanceof SwmAuthorInventoryMutationNoopErrorV1) {
        throw this.host.error(
          'swm-inventory-input',
          cause.status === 'existing'
            ? 'SWM author inventory mutation must change the exact row set'
            : 'SWM author inventory removal target is absent',
          { cause },
        );
      }
      throw this.host.error(
        'swm-inventory-input',
        'SWM author inventory mutation cannot produce a canonical row set',
        { cause },
      );
    }
    if (!swmAuthorInventoryRowsEqualV1(rows, next.snapshot.rows)) {
      throw this.host.error(
        'swm-inventory-input',
        'signed SWM author inventory row set is not the exact requested mutation',
      );
    }
  }

  private conflict(actual: Digest32V1 | null, expected: Digest32V1 | null): Error {
    return this.host.error(
      'swm-inventory-cas-conflict',
      `SWM author inventory CAS expected ${expected ?? 'no current head'} but found ${actual ?? 'none'}`,
    );
  }
}

function swmAuthorInventoryRowsEqualV1(
  left: SwmAuthorInventorySnapshotV1['rows'],
  right: SwmAuthorInventorySnapshotV1['rows'],
): boolean {
  return sqlBlobsEqualV1(
    canonicalizeSwmAuthorInventoryRowsBytesV1(left),
    canonicalizeSwmAuthorInventoryRowsBytesV1(right),
  );
}

function swmAuthorInventorySnapshotsEqualV1(
  left: SwmAuthorInventorySnapshotV1,
  right: SwmAuthorInventorySnapshotV1,
): boolean {
  return left.head.objectDigest === right.head.objectDigest
    && sqlBlobsEqualV1(
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(left.head),
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(right.head),
    )
    && swmAuthorInventoryRowsEqualV1(left.rows, right.rows);
}

function swmAuthorInventoryReplayEvidenceEqualV1(
  stored: StoredSwmAuthorInventoryCommitV1,
  requested: PreparedSwmAuthorInventoryCommitV1,
): boolean {
  return nullableSqlBlobsEqualV1(stored.expectedHead, requested.expectedHead)
    && stored.mutationKind === requested.mutationKind
    && stored.mutationKaUal === requested.mutationKaUal;
}
