import type { SQLInputValue } from 'node:sqlite';

import {
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type Digest32V1,
  type SwmAuthorInventoryRowV1,
} from '@origintrail-official/dkg-core';

import type {
  EncodedSwmAuthorInventoryKeyV1,
  PreparedSwmAuthorInventoryCommitV1,
} from './swm-author-inventory-commit-plan.js';
import {
  decimalU64ToSqlBlobV1,
  digest32ToSqlBlobV1,
  sqlBlobToDecimalU64V1,
  sqlBlobToDigest32V1,
} from './scalars.js';

export type SqlRowV1 = Record<string, unknown>;
export type SqlParametersV1 = Record<string, SQLInputValue>;

export function swmAuthorKeyParametersV1(
  key: EncodedSwmAuthorInventoryKeyV1,
): SqlParametersV1 {
  return { scope: key.scope, author: key.author };
}

export function swmAuthorHeadParametersV1(
  head: PreparedSwmAuthorInventoryCommitV1,
): SqlParametersV1 {
  const payload = head.snapshot.head.payload;
  return {
    ...swmAuthorKeyParametersV1(head),
    nextHead: digest32ToSqlBlobV1(head.snapshot.head.objectDigest as Digest32V1),
    inventoryVersion: decimalU64ToSqlBlobV1(payload.version),
    totalRows: decimalU64ToSqlBlobV1(payload.totalRows),
    rowsDigest: digest32ToSqlBlobV1(payload.rowsDigest),
    signedHeadEnvelope: head.signedHeadEnvelope,
    expectedHead: head.expectedHead,
    mutationKind: head.mutationKind,
    mutationKaUal: head.mutationKaUal,
  };
}

export function swmAuthorRowParametersV1(
  row: SwmAuthorInventoryRowV1,
): SqlParametersV1 {
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

export function decodeStoredSwmAuthorInventoryRowV1(
  row: SqlRowV1,
): SwmAuthorInventoryRowV1 {
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

export function assertBoundedSqlBlobV1(
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

function assertSqlTextV1(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`stored ${label} is not TEXT`);
  return value;
}
