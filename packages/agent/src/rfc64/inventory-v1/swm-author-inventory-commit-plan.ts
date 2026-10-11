import {
  assertCanonicalDigest,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  computeSwmAuthorInventoryScopeDigestV1,
  deriveSwmAuthorInventoryScopeFromHeadV1,
  type EvmAddressV1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';

import {
  type SwmAuthorInventoryErrorFactoryV1,
  type SwmAuthorInventoryMutationV1,
} from './swm-author-inventory-contracts.js';
import type {
  VerifiedMergeSwmAuthorInventoryCommitInputV1,
  VerifiedSwmAuthorInventoryCommitInputV1,
} from './swm-author-inventory-auth-v1.js';
import {
  digest32ToSqlBlobV1,
  evmAddressToSqlBlobV1,
} from './scalars.js';

export interface EncodedSwmAuthorInventoryKeyV1 {
  readonly scope: Uint8Array;
  readonly author: Uint8Array;
}

/** Immutable plan observed once at the caller boundary and reused through recovery. */
export interface PreparedSwmAuthorInventoryCommitV1
  extends EncodedSwmAuthorInventoryKeyV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  readonly mutation: SwmAuthorInventoryMutationV1;
  readonly mutationKind: SwmAuthorInventoryMutationV1['kind'];
  readonly mutationKaUal: string;
  readonly expectedHead: Uint8Array | null;
  readonly signedHeadEnvelope: Uint8Array;
}

/**
 * Prepared exact-merge plan. The compatibility replay marker deliberately uses
 * `remove` plus a UAL present in the resulting snapshot. Such metadata cannot
 * describe a valid ordinary remove transition, while satisfying v1 schemas
 * whose CHECK constraint only admits `upsert` and `remove`.
 */
export interface PreparedMergeSwmAuthorInventoryCommitV1
  extends EncodedSwmAuthorInventoryKeyV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  readonly mergeRows: SwmAuthorInventorySnapshotV1['rows'];
  readonly mutationKind: 'remove';
  readonly mutationKaUal: string;
  readonly expectedHead: Uint8Array | null;
  readonly signedHeadEnvelope: Uint8Array;
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
  input: VerifiedSwmAuthorInventoryCommitInputV1,
  error: SwmAuthorInventoryErrorFactoryV1,
): PreparedSwmAuthorInventoryCommitV1 {
  try {
    const { snapshot, mutation } = input;
    const { head } = snapshot;
    const scope = deriveSwmAuthorInventoryScopeFromHeadV1(head.payload);
    const key = encodeSwmAuthorInventoryKeyV1(
      computeSwmAuthorInventoryScopeDigestV1(scope),
      head.payload.authorAddress,
      error,
    );
    let expectedHead: Uint8Array | null = null;
    if (input.expectedCurrentHeadDigest !== null) {
      expectedHead = digest32ToSqlBlobV1(input.expectedCurrentHeadDigest);
    }
    return Object.freeze({
      ...key,
      snapshot,
      mutation,
      mutationKind: mutation.kind,
      mutationKaUal: mutation.kind === 'upsert' ? mutation.row.kaUal : mutation.kaUal,
      expectedHead,
      signedHeadEnvelope: canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(head),
    });
  } catch (cause) {
    throw error(
      'swm-inventory-input',
      'verified SWM author inventory CAS input cannot be encoded for persistence',
      { cause },
    );
  }
}

export function prepareMergeSwmAuthorInventoryCommitV1(
  input: VerifiedMergeSwmAuthorInventoryCommitInputV1,
  error: SwmAuthorInventoryErrorFactoryV1,
): PreparedMergeSwmAuthorInventoryCommitV1 {
  try {
    const { snapshot, mergeRows } = input;
    const { head } = snapshot;
    const scope = deriveSwmAuthorInventoryScopeFromHeadV1(head.payload);
    const key = encodeSwmAuthorInventoryKeyV1(
      computeSwmAuthorInventoryScopeDigestV1(scope),
      head.payload.authorAddress,
      error,
    );
    let expectedHead: Uint8Array | null = null;
    if (input.expectedCurrentHeadDigest !== null) {
      expectedHead = digest32ToSqlBlobV1(input.expectedCurrentHeadDigest);
    }
    const markerRow = snapshot.rows[0];
    if (markerRow === undefined || mergeRows.length === 0) {
      throw new Error('exact merge and resulting inventory must both be non-empty');
    }
    return Object.freeze({
      ...key,
      snapshot,
      mergeRows,
      mutationKind: 'remove' as const,
      mutationKaUal: markerRow.kaUal,
      expectedHead,
      signedHeadEnvelope: canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(head),
    });
  } catch (cause) {
    throw error(
      'swm-inventory-input',
      'verified SWM author inventory exact merge cannot be encoded for persistence',
      { cause },
    );
  }
}
