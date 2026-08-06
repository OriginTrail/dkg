import {
  assertCanonicalDeterministicUalV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  compareSwmAuthorInventoryRowsV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type SwmAuthorInventoryRowV1,
} from '@origintrail-official/dkg-core';

import type { SwmAuthorInventoryMutationV1 } from './swm-author-inventory-contracts.js';
import {
  assertExactFieldSetV1,
  snapshotPlainDataRecordV1,
} from './exact-record.js';

export type SwmAuthorInventoryMutationPlanV1 = Readonly<{
  status: 'applied' | 'existing' | 'absent';
  rows: readonly SwmAuthorInventoryRowV1[];
}>;

export class SwmAuthorInventoryMutationNoopErrorV1 extends Error {
  readonly status: 'existing' | 'absent';

  constructor(status: 'existing' | 'absent') {
    super(`SWM author inventory mutation resolved as ${status}`);
    this.name = 'SwmAuthorInventoryMutationNoopErrorV1';
    this.status = status;
  }
}

/** Snapshot one caller-owned mutation into its canonical protocol shape. */
export function snapshotSwmAuthorInventoryMutationV1(
  mutation: unknown,
): SwmAuthorInventoryMutationV1 {
  const candidate = snapshotPlainDataRecordV1(mutation, 'SWM author inventory mutation');
  if (candidate.kind === 'upsert') {
    assertExactFieldSetV1(candidate, ['kind', 'row'], 'SWM author inventory upsert mutation');
    const rows = parseCanonicalSwmAuthorInventoryRowsV1(
      canonicalizeSwmAuthorInventoryRowsBytesV1([
        candidate.row as SwmAuthorInventoryRowV1,
      ]),
    );
    return Object.freeze({ kind: 'upsert' as const, row: rows[0]! });
  }
  if (candidate.kind === 'remove' && typeof candidate.kaUal === 'string') {
    assertExactFieldSetV1(candidate, ['kind', 'kaUal'], 'SWM author inventory remove mutation');
    const kaUal = assertCanonicalDeterministicUalV1(candidate.kaUal).ual;
    return Object.freeze({ kind: 'remove' as const, kaUal });
  }
  throw new TypeError('SWM author inventory mutation has an invalid payload');
}

/** One canonical row-set transition model shared by producer and persistence. */
export function applySwmAuthorInventoryMutationV1(
  current: readonly SwmAuthorInventoryRowV1[],
  mutation: SwmAuthorInventoryMutationV1,
): SwmAuthorInventoryMutationPlanV1 {
  const rows = [...current];
  if (mutation.kind === 'upsert') {
    const index = rows.findIndex((row) => row.kaUal === mutation.row.kaUal);
    if (index >= 0 && rowsEqual(rows[index]!, mutation.row)) {
      return Object.freeze({ status: 'existing' as const, rows: canonicalRows(rows) });
    }
    if (index >= 0) rows[index] = mutation.row;
    else rows.push(mutation.row);
  } else {
    const index = rows.findIndex((row) => row.kaUal === mutation.kaUal);
    if (index < 0) {
      return Object.freeze({ status: 'absent' as const, rows: canonicalRows(rows) });
    }
    rows.splice(index, 1);
  }
  return Object.freeze({ status: 'applied' as const, rows: canonicalRows(rows) });
}

/** Persistence projector: require one mutation to change the canonical row set. */
export function requireAppliedSwmAuthorInventoryMutationV1(
  current: readonly SwmAuthorInventoryRowV1[],
  mutation: SwmAuthorInventoryMutationV1,
): readonly SwmAuthorInventoryRowV1[] {
  const plan = applySwmAuthorInventoryMutationV1(current, mutation);
  if (plan.status !== 'applied') {
    throw new SwmAuthorInventoryMutationNoopErrorV1(plan.status);
  }
  return plan.rows;
}

function canonicalRows(
  rows: readonly SwmAuthorInventoryRowV1[],
): readonly SwmAuthorInventoryRowV1[] {
  const ordered = [...rows].sort(compareSwmAuthorInventoryRowsV1);
  return parseCanonicalSwmAuthorInventoryRowsV1(
    canonicalizeSwmAuthorInventoryRowsBytesV1(ordered),
  );
}

function rowsEqual(
  left: SwmAuthorInventoryRowV1,
  right: SwmAuthorInventoryRowV1,
): boolean {
  const leftBytes = canonicalizeSwmAuthorInventoryRowsBytesV1([left]);
  const rightBytes = canonicalizeSwmAuthorInventoryRowsBytesV1([right]);
  return leftBytes.byteLength === rightBytes.byteLength
    && leftBytes.every((byte, index) => byte === rightBytes[index]);
}
