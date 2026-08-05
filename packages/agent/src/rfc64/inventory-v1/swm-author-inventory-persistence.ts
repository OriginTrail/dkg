import type { SQLInputValue, StatementSync } from 'node:sqlite';

import {
  MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1,
  assertCanonicalDeterministicUalV1,
  assertCanonicalDigest,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  computeSwmAuthorInventoryScopeDigestV1,
  deriveSwmAuthorInventoryScopeFromHeadV1,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type Digest32V1,
  type EvmAddressV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';

import type {
  CompareAndSwapSwmAuthorInventoryInputV1,
  SwmAuthorInventoryCasResultV1,
  SwmAuthorInventoryErrorCodeV1,
  SwmAuthorInventoryMutationV1,
} from './swm-author-inventory-contracts.js';
import {
  assertExactFieldSetV1,
  snapshotExactPlainDataRecordV1,
  snapshotPlainDataRecordV1,
} from './exact-record.js';
import {
  assertSqlBlobWidthV1,
  decimalU64ToSqlBlobV1,
  digest32ToSqlBlobV1,
  evmAddressToSqlBlobV1,
  sqlBlobToDecimalU64V1,
  sqlBlobToDigest32V1,
  sqlBlobToEvmAddressV1,
} from './scalars.js';
import { INVENTORY_V1_STATEMENT_SQL } from './statements.js';

type SqlRowV1 = Record<string, unknown>;
type SqlParametersV1 = Record<string, SQLInputValue>;
type SwmInventoryErrorCodeV1 = SwmAuthorInventoryErrorCodeV1;

const SWM_AUTHOR_INVENTORY_MUTATION_UPSERT_V1 = 0x75;
const SWM_AUTHOR_INVENTORY_MUTATION_REMOVE_V1 = 0x72;
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export interface EncodedSwmAuthorInventoryKeyV1 {
  readonly scope: Uint8Array;
  readonly author: Uint8Array;
}

/**
 * One immutable, descriptor-safe commit plan. Caller objects are observed once
 * at the API boundary; validation, write, retry, and indeterminate-COMMIT
 * resolution all consume this same plan.
 *
 * @internal
 */
export interface PreparedSwmAuthorInventoryCommitV1
  extends EncodedSwmAuthorInventoryKeyV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  readonly mutation: SwmAuthorInventoryMutationV1;
  readonly expectedHead: Uint8Array | null;
  readonly nextHead: Uint8Array;
  readonly inventoryVersion: Uint8Array;
  readonly totalRows: Uint8Array;
  readonly rowsDigest: Uint8Array;
  readonly signedHeadEnvelope: Uint8Array;
  readonly canonicalMutation: Uint8Array;
}

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

/** @internal */
export function encodeSwmAuthorInventoryKeyV1(
  inventoryScopeDigest: unknown,
  authorAddress: unknown,
  error: SwmAuthorInventoryPersistenceHostV1['error'],
): EncodedSwmAuthorInventoryKeyV1 {
  try {
    assertCanonicalDigest(inventoryScopeDigest, 'inventoryScopeDigest');
    return Object.freeze({
      scope: digest32ToSqlBlobV1(inventoryScopeDigest),
      author: evmAddressToSqlBlobV1(authorAddress as EvmAddressV1),
    });
  } catch (cause) {
    throw error(
      'swm-inventory-input',
      'SWM author inventory key is not canonical',
      { cause },
    );
  }
}

/** @internal */
export function prepareSwmAuthorInventoryCommitV1(
  input: CompareAndSwapSwmAuthorInventoryInputV1,
  error: SwmAuthorInventoryPersistenceHostV1['error'],
): PreparedSwmAuthorInventoryCommitV1 {
  try {
    const candidate = snapshotExactPlainDataRecordV1(
      input,
      ['snapshot', 'mutation', 'expectedCurrentHeadDigest'],
      'SWM author inventory CAS input',
    );
    const candidateSnapshot = snapshotExactPlainDataRecordV1(
      candidate.snapshot,
      ['head', 'rows'],
      'SWM author inventory snapshot',
    );
    const head = parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1(
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(
        candidateSnapshot.head as SwmAuthorInventorySnapshotV1['head'],
      ),
    );
    const rows = parseCanonicalSwmAuthorInventoryRowsV1(
      canonicalizeSwmAuthorInventoryRowsBytesV1(
        candidateSnapshot.rows as readonly SwmAuthorInventoryRowV1[],
      ),
    );
    const snapshot = Object.freeze({ head, rows });
    assertSwmAuthorInventorySnapshotBindingV1(snapshot);
    const scope = deriveSwmAuthorInventoryScopeFromHeadV1(head.payload);
    const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(scope);
    const key = encodeSwmAuthorInventoryKeyV1(
      inventoryScopeDigest,
      head.payload.authorAddress,
      error,
    );
    let expectedHead: Uint8Array | null = null;
    if (candidate.expectedCurrentHeadDigest !== null) {
      assertCanonicalDigest(candidate.expectedCurrentHeadDigest, 'expectedCurrentHeadDigest');
      expectedHead = digest32ToSqlBlobV1(candidate.expectedCurrentHeadDigest);
    }
    const mutation = snapshotSwmAuthorInventoryMutationV1(candidate.mutation, error);
    return Object.freeze({
      ...key,
      snapshot,
      mutation,
      expectedHead,
      nextHead: digest32ToSqlBlobV1(head.objectDigest as Digest32V1),
      inventoryVersion: decimalU64ToSqlBlobV1(head.payload.version),
      totalRows: decimalU64ToSqlBlobV1(head.payload.totalRows),
      rowsDigest: digest32ToSqlBlobV1(head.payload.rowsDigest),
      signedHeadEnvelope: canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(head),
      canonicalMutation: encodeSwmAuthorInventoryMutationV1(mutation),
    });
  } catch (cause) {
    if (isSwmInventoryCandidateError(cause)) throw cause;
    throw error(
      'swm-inventory-input',
      'SWM author inventory CAS input is not canonical or internally bound',
      { cause },
    );
  }
}

/**
 * Connection-bound SWM persistence subsystem. Transaction ownership remains in
 * CandidateInventoryV1; this class owns only the exact SQL/read/CAS semantics.
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
      const rowsQuery = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.getSwmAuthorRows);
      const storedRows = this.host.statement(() => rowsQuery.all({
        scope: key.scope,
        author: key.author,
      }) as SqlRowV1[]);
      const rows = Object.freeze(storedRows.map(decodeStoredSwmAuthorInventoryRowV1));
      const snapshot = Object.freeze({ head, rows });
      assertSwmAuthorInventorySnapshotBindingV1(snapshot);
      const expectedHead = headRow.expected_head_digest === null
        ? null
        : assertSqlBlobWidthV1(headRow.expected_head_digest, 32, 'stored expected head');
      const canonicalMutation = assertBoundedSqlBlobV1(
        headRow.canonical_mutation,
        2,
        MAX_SWM_AUTHOR_INVENTORY_ROWS_BYTES_V1 + 1,
        'stored SWM author inventory mutation',
      );
      decodeSwmAuthorInventoryMutationV1(canonicalMutation, this.host.error);
      if (
        (expectedHead === null ? null : inputDigestV1(expectedHead))
        !== head.payload.previousHeadDigest
      ) {
        throw new Error('stored replay predecessor does not match the signed head');
      }
      return Object.freeze({ snapshot, expectedHead, canonicalMutation });
    } catch (cause) {
      if (isSwmInventoryCandidateError(cause, 'swm-inventory-database-corrupt')) throw cause;
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
    const expectedRows = applySwmAuthorInventoryMutationV1(
      current?.rows ?? [],
      next.mutation,
      this.host.error,
    );
    if (!swmAuthorInventoryRowsEqualV1(expectedRows, next.snapshot.rows)) {
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

function snapshotSwmAuthorInventoryMutationV1(
  mutation: unknown,
  error: SwmAuthorInventoryPersistenceHostV1['error'],
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
  throw error('swm-inventory-input', 'SWM author inventory mutation has an invalid payload');
}

function swmAuthorKeyParametersV1(key: EncodedSwmAuthorInventoryKeyV1): SqlParametersV1 {
  return { scope: key.scope, author: key.author };
}

function swmAuthorHeadParametersV1(
  head: PreparedSwmAuthorInventoryCommitV1,
): SqlParametersV1 {
  return {
    ...swmAuthorKeyParametersV1(head),
    nextHead: head.nextHead,
    inventoryVersion: head.inventoryVersion,
    totalRows: head.totalRows,
    rowsDigest: head.rowsDigest,
    signedHeadEnvelope: head.signedHeadEnvelope,
    expectedHead: head.expectedHead,
    canonicalMutation: head.canonicalMutation,
  };
}

function encodeSwmAuthorInventoryMutationV1(
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

function decodeSwmAuthorInventoryMutationV1(
  bytes: Uint8Array,
  error: SwmAuthorInventoryPersistenceHostV1['error'],
): SwmAuthorInventoryMutationV1 {
  if (bytes[0] === SWM_AUTHOR_INVENTORY_MUTATION_UPSERT_V1) {
    const rows = parseCanonicalSwmAuthorInventoryRowsV1(bytes.subarray(1));
    if (rows.length !== 1) {
      throw error('swm-inventory-database-corrupt', 'stored upsert replay has no exact row');
    }
    return Object.freeze({ kind: 'upsert' as const, row: rows[0]! });
  }
  if (bytes[0] === SWM_AUTHOR_INVENTORY_MUTATION_REMOVE_V1) {
    const kaUal = assertCanonicalDeterministicUalV1(UTF8_FATAL.decode(bytes.subarray(1))).ual;
    return Object.freeze({ kind: 'remove' as const, kaUal });
  }
  throw error('swm-inventory-database-corrupt', 'stored SWM mutation tag is invalid');
}

function swmAuthorRowParametersV1(row: SwmAuthorInventoryRowV1): SqlParametersV1 {
  return {
    kaUal: row.kaUal,
    assertionCoordinate: row.assertionCoordinate,
    assertionVersion: decimalU64ToSqlBlobV1(row.assertionVersion),
    shareOperationId: row.shareOperationId,
    projectionDigest: digest32ToSqlBlobV1(row.projectionDigest),
    publicTripleCount: decimalU64ToSqlBlobV1(row.publicTripleCount),
    privateTripleCount: decimalU64ToSqlBlobV1(row.privateTripleCount),
    sealDigest: digest32ToSqlBlobV1(row.sealDigest),
    sharedAt: decimalU64ToSqlBlobV1(row.sharedAt),
    expiresAt: row.expiresAt === null ? null : decimalU64ToSqlBlobV1(row.expiresAt),
  };
}

function decodeStoredSwmAuthorInventoryRowV1(row: SqlRowV1): SwmAuthorInventoryRowV1 {
  const decoded = {
    assertionCoordinate: assertSqlTextV1(row.assertion_coordinate, 'assertion_coordinate'),
    assertionVersion: sqlBlobToDecimalU64V1(row.assertion_version_u64be),
    kaUal: assertSqlTextV1(row.ka_ual, 'ka_ual'),
    shareOperationId: assertSqlTextV1(row.share_operation_id, 'share_operation_id'),
    projectionDigest: sqlBlobToDigest32V1(row.projection_digest),
    publicTripleCount: sqlBlobToDecimalU64V1(row.public_triple_count_u64be),
    privateTripleCount: sqlBlobToDecimalU64V1(row.private_triple_count_u64be),
    sealDigest: sqlBlobToDigest32V1(row.seal_digest),
    sharedAt: sqlBlobToDecimalU64V1(row.shared_at_u64be),
    expiresAt: row.expires_at_u64be === null
      ? null
      : sqlBlobToDecimalU64V1(row.expires_at_u64be),
  } as SwmAuthorInventoryRowV1;
  return parseCanonicalSwmAuthorInventoryRowsV1(
    canonicalizeSwmAuthorInventoryRowsBytesV1([decoded]),
  )[0]!;
}

function applySwmAuthorInventoryMutationV1(
  current: readonly SwmAuthorInventoryRowV1[],
  mutation: SwmAuthorInventoryMutationV1,
  error: SwmAuthorInventoryPersistenceHostV1['error'],
): readonly SwmAuthorInventoryRowV1[] {
  const rows = [...current];
  if (mutation.kind === 'upsert') {
    const index = rows.findIndex((row) => row.kaUal === mutation.row.kaUal);
    if (index >= 0) {
      if (swmAuthorInventoryRowsEqualV1([rows[index]!], [mutation.row])) {
        throw error(
          'swm-inventory-input',
          'SWM author inventory mutation must change the exact row set',
        );
      }
      rows[index] = mutation.row;
    } else {
      rows.push(mutation.row);
    }
  } else {
    const index = rows.findIndex((row) => row.kaUal === mutation.kaUal);
    if (index < 0) {
      throw error('swm-inventory-input', 'SWM author inventory removal target is absent');
    }
    rows.splice(index, 1);
  }
  rows.sort((left, right) => left.kaUal < right.kaUal ? -1 : left.kaUal > right.kaUal ? 1 : 0);
  return Object.freeze(rows);
}

function swmAuthorInventoryRowsEqualV1(
  left: readonly SwmAuthorInventoryRowV1[],
  right: readonly SwmAuthorInventoryRowV1[],
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

function assertSqlTextV1(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`stored ${label} is not TEXT`);
  return value;
}

function assertBoundedSqlBlobV1(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${label} is outside its bounded BLOB shape`);
  }
  return value.slice();
}

function byteArraysEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function nullableByteArraysEqualV1(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  return left === null || right === null ? left === right : byteArraysEqualV1(left, right);
}

function inputDigestV1(bytes: Uint8Array): Digest32V1 {
  return sqlBlobToDigest32V1(assertSqlBlobWidthV1(bytes, 32, 'expected current head'));
}

function isSwmInventoryCandidateError(
  value: unknown,
  code?: SwmInventoryErrorCodeV1,
): value is Error & { readonly code: SwmInventoryErrorCodeV1 } {
  if (!(value instanceof Error) || !('code' in value)) return false;
  const actual = (value as Error & { readonly code?: unknown }).code;
  return (
    actual === 'swm-inventory-input'
    || actual === 'swm-inventory-cas-conflict'
    || actual === 'swm-inventory-database-corrupt'
  ) && (code === undefined || actual === code);
}
