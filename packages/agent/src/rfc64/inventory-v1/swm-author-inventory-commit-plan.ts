import {
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
  SwmAuthorInventoryErrorCodeV1,
  SwmAuthorInventoryMutationV1,
} from './swm-author-inventory-contracts.js';
import { snapshotExactPlainDataRecordV1 } from './exact-record.js';
import {
  decimalU64ToSqlBlobV1,
  digest32ToSqlBlobV1,
  evmAddressToSqlBlobV1,
} from './scalars.js';
import {
  encodeSwmAuthorInventoryMutationV1,
  snapshotSwmAuthorInventoryMutationV1,
} from './swm-author-inventory-mutation.js';

export type SwmAuthorInventoryErrorFactoryV1 = (
  code: SwmAuthorInventoryErrorCodeV1,
  message: string,
  options?: ErrorOptions,
) => Error;

export interface EncodedSwmAuthorInventoryKeyV1 {
  readonly scope: Uint8Array;
  readonly author: Uint8Array;
}

/** Immutable plan observed once at the caller boundary and reused through recovery. */
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

export function encodeSwmAuthorInventoryKeyV1(
  inventoryScopeDigest: unknown,
  authorAddress: unknown,
  error: SwmAuthorInventoryErrorFactoryV1,
): EncodedSwmAuthorInventoryKeyV1 {
  try {
    assertCanonicalDigest(inventoryScopeDigest, 'inventoryScopeDigest');
    return Object.freeze({
      scope: digest32ToSqlBlobV1(inventoryScopeDigest),
      author: evmAddressToSqlBlobV1(authorAddress as EvmAddressV1),
    });
  } catch (cause) {
    throw error('swm-inventory-input', 'SWM author inventory key is not canonical', { cause });
  }
}

export function prepareSwmAuthorInventoryCommitV1(
  input: CompareAndSwapSwmAuthorInventoryInputV1,
  error: SwmAuthorInventoryErrorFactoryV1,
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
    const key = encodeSwmAuthorInventoryKeyV1(
      computeSwmAuthorInventoryScopeDigestV1(scope),
      head.payload.authorAddress,
      error,
    );
    let expectedHead: Uint8Array | null = null;
    if (candidate.expectedCurrentHeadDigest !== null) {
      assertCanonicalDigest(candidate.expectedCurrentHeadDigest, 'expectedCurrentHeadDigest');
      expectedHead = digest32ToSqlBlobV1(candidate.expectedCurrentHeadDigest);
    }
    const mutation = snapshotSwmAuthorInventoryMutationV1(candidate.mutation);
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
    if (isSwmAuthorInventoryErrorV1(cause)) throw cause;
    throw error(
      'swm-inventory-input',
      'SWM author inventory CAS input is not canonical or internally bound',
      { cause },
    );
  }
}

function isSwmAuthorInventoryErrorV1(
  value: unknown,
): value is Error & { readonly code: SwmAuthorInventoryErrorCodeV1 } {
  if (!(value instanceof Error) || !('code' in value)) return false;
  const code = (value as Error & { readonly code?: unknown }).code;
  return code === 'swm-inventory-input'
    || code === 'swm-inventory-cas-conflict'
    || code === 'swm-inventory-database-corrupt';
}
