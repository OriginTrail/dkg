import {
  assertCanonicalDeterministicUalV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type SwmAuthorInventoryRowV1,
} from '@origintrail-official/dkg-core';

import type { SwmAuthorInventoryMutationV1 } from './swm-author-inventory-contracts.js';
import {
  assertExactFieldSetV1,
  snapshotPlainDataRecordV1,
} from './exact-record.js';

const SWM_AUTHOR_INVENTORY_MUTATION_UPSERT_V1 = 0x75;
const SWM_AUTHOR_INVENTORY_MUTATION_REMOVE_V1 = 0x72;
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export type SwmAuthorInventoryMutationPlanV1 = Readonly<{
  status: 'applied' | 'existing' | 'absent';
  rows: readonly SwmAuthorInventoryRowV1[];
}>;

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

/** Stable replay-evidence encoding for one canonical mutation. */
export function encodeSwmAuthorInventoryMutationV1(
  mutation: SwmAuthorInventoryMutationV1,
): Uint8Array {
  const payload = mutation.kind === 'upsert'
    ? canonicalizeSwmAuthorInventoryRowsBytesV1([mutation.row])
    : new TextEncoder().encode(mutation.kaUal);
  const encoded = new Uint8Array(payload.byteLength + 1);
  encoded[0] = mutation.kind === 'upsert'
    ? SWM_AUTHOR_INVENTORY_MUTATION_UPSERT_V1
    : SWM_AUTHOR_INVENTORY_MUTATION_REMOVE_V1;
  encoded.set(payload, 1);
  return encoded;
}

/** Decode and validate mutation replay evidence read from durable storage. */
export function decodeSwmAuthorInventoryMutationV1(
  bytes: Uint8Array,
): SwmAuthorInventoryMutationV1 {
  if (bytes[0] === SWM_AUTHOR_INVENTORY_MUTATION_UPSERT_V1) {
    const rows = parseCanonicalSwmAuthorInventoryRowsV1(bytes.subarray(1));
    if (rows.length !== 1) throw new Error('stored upsert replay has no exact row');
    return Object.freeze({ kind: 'upsert' as const, row: rows[0]! });
  }
  if (bytes[0] === SWM_AUTHOR_INVENTORY_MUTATION_REMOVE_V1) {
    const kaUal = assertCanonicalDeterministicUalV1(
      UTF8_FATAL.decode(bytes.subarray(1)),
    ).ual;
    return Object.freeze({ kind: 'remove' as const, kaUal });
  }
  throw new Error('stored SWM mutation tag is invalid');
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

function canonicalRows(
  rows: readonly SwmAuthorInventoryRowV1[],
): readonly SwmAuthorInventoryRowV1[] {
  const ordered = [...rows].sort((left, right) => (
    left.kaUal < right.kaUal ? -1 : left.kaUal > right.kaUal ? 1 : 0
  ));
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
