import type { StatementSync } from 'node:sqlite';

import {
  MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
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
  applySwmAuthorInventoryMutationV1,
  decodeSwmAuthorInventoryMutationV1,
} from './swm-author-inventory-mutation.js';
import {
  sqlBlobToDecimalU64V1,
  sqlBlobToDigest32V1,
  sqlBlobToEvmAddressV1,
} from './scalars.js';
import { INVENTORY_V1_STATEMENT_SQL } from './statements.js';
import {
  assertBoundedSqlBlobV1,
  byteArraysEqualV1,
  decodeStoredSwmAuthorInventoryRowV1,
  inputDigestV1,
  nullableByteArraysEqualV1,
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
  readonly canonicalMutation: Uint8Array;
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
      const rows = Object.freeze(storedRows.map(decodeStoredSwmAuthorInventoryRowV1));
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
      const canonicalMutation = assertBoundedSqlBlobV1(
        headRow.canonical_mutation,
        2,
        MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1 + 1,
        'stored SWM author inventory mutation',
      );
      decodeSwmAuthorInventoryMutationV1(canonicalMutation);
      if (
        (expectedHead === null ? null : inputDigestV1(expectedHead))
        !== head.payload.previousHeadDigest
      ) {
        throw new Error('stored replay predecessor does not match the signed head');
      }
      return Object.freeze({ snapshot, expectedHead, canonicalMutation });
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
    const current = this.readStored(next);
    if (
      current !== null
      && current.snapshot.head.objectDigest === next.snapshot.head.objectDigest
    ) {
      if (!swmAuthorInventorySnapshotsEqualV1(current.snapshot, next.snapshot)) {
        throw this.host.error(
          'swm-inventory-database-corrupt',
          'one SWM inventory head digest resolved to different exact state',
        );
      }
      if (!swmAuthorInventoryReplayEvidenceEqualV1(current, next)) {
        throw this.host.error(
          'swm-inventory-input',
          'already-current SWM inventory was not produced by the exact requested CAS mutation',
        );
      }
      return Object.freeze({ status: 'existing' as const, snapshot: current.snapshot });
    }
    this.assertTransition(current?.snapshot ?? null, next);

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
          next.expectedHead === null ? null : inputDigestV1(next.expectedHead),
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

    const committed = this.readStored(next);
    if (
      committed === null
      || !swmAuthorInventorySnapshotsEqualV1(committed.snapshot, next.snapshot)
      || !swmAuthorInventoryReplayEvidenceEqualV1(committed, next)
    ) {
      throw this.host.error(
        'swm-inventory-database-corrupt',
        'SWM author inventory write did not exact-read as the requested next state',
      );
    }
    return Object.freeze({ status: 'applied' as const, snapshot: committed.snapshot });
  }

  resolve(next: PreparedSwmAuthorInventoryCommitV1): SwmAuthorInventoryCommitResolutionV1 {
    const current = this.readStored(next);
    if (
      current !== null
      && current.snapshot.head.objectDigest === next.snapshot.head.objectDigest
      && swmAuthorInventorySnapshotsEqualV1(current.snapshot, next.snapshot)
      && swmAuthorInventoryReplayEvidenceEqualV1(current, next)
    ) return 'committed';
    const expected = next.expectedHead === null ? null : inputDigestV1(next.expectedHead);
    if ((current?.snapshot.head.objectDigest ?? null) === expected) return 'not-committed';
    throw this.conflict(
      (current?.snapshot.head.objectDigest as Digest32V1 | undefined) ?? null,
      expected,
    );
  }

  private assertTransition(
    current: SwmAuthorInventorySnapshotV1 | null,
    next: PreparedSwmAuthorInventoryCommitV1,
  ): void {
    const actual = current?.head.objectDigest as Digest32V1 | undefined;
    const expected = next.expectedHead === null ? null : inputDigestV1(next.expectedHead);
    if ((actual ?? null) !== expected) throw this.conflict(actual ?? null, expected);
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
    let transition;
    try {
      transition = applySwmAuthorInventoryMutationV1(current?.rows ?? [], next.mutation);
    } catch (cause) {
      throw this.host.error(
        'swm-inventory-input',
        'SWM author inventory mutation cannot produce a canonical row set',
        { cause },
      );
    }
    if (transition.status !== 'applied') {
      throw this.host.error(
        'swm-inventory-input',
        transition.status === 'existing'
          ? 'SWM author inventory mutation must change the exact row set'
          : 'SWM author inventory removal target is absent',
      );
    }
    if (!swmAuthorInventoryRowsEqualV1(transition.rows, next.snapshot.rows)) {
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
  return byteArraysEqualV1(
    canonicalizeSwmAuthorInventoryRowsBytesV1(left),
    canonicalizeSwmAuthorInventoryRowsBytesV1(right),
  );
}

function swmAuthorInventorySnapshotsEqualV1(
  left: SwmAuthorInventorySnapshotV1,
  right: SwmAuthorInventorySnapshotV1,
): boolean {
  return left.head.objectDigest === right.head.objectDigest
    && byteArraysEqualV1(
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(left.head),
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(right.head),
    )
    && swmAuthorInventoryRowsEqualV1(left.rows, right.rows);
}

function swmAuthorInventoryReplayEvidenceEqualV1(
  stored: StoredSwmAuthorInventoryCommitV1,
  requested: PreparedSwmAuthorInventoryCommitV1,
): boolean {
  return nullableByteArraysEqualV1(stored.expectedHead, requested.expectedHead)
    && byteArraysEqualV1(stored.canonicalMutation, requested.canonicalMutation);
}
