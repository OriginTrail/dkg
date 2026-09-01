// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  assertAssertionCoordinateV1,
  assertCanonicalDeterministicUalV1,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertSwmAuthorInventoryScopeV1,
  parseCanonicalDecimalU64,
  type AssertionCoordinateV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type PositiveDecimalU64V1,
  type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';

import type { Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 } from
  './swm-author-inventory-producer-v1.js';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface Rfc64FinalizedPrivatePlacementRepairV1
  extends Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 {
  readonly version: 1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  /** Exact confirmation-time scope; a policy transition must not redirect recovery. */
  readonly inventoryScope: SwmAuthorInventoryScopeV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly assertionVersion: PositiveDecimalU64V1;
  readonly kaUal: CanonicalDeterministicUalV1;
  readonly sealDigest: Digest32V1;
}

/** The repair queue is implemented by the single owned inventory connection. */
export interface Rfc64FinalizedPrivatePlacementRepairOperationsV1 {
  listFinalizedPrivatePlacementRepairs(): readonly Readonly<Rfc64FinalizedPrivatePlacementRepairV1>[];
  putFinalizedPrivatePlacementRepair(
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): void;
  deleteFinalizedPrivatePlacementRepair(
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): void;
}

export interface Rfc64FinalizedPrivatePlacementRepairStoreV1 {
  list(): readonly Readonly<Rfc64FinalizedPrivatePlacementRepairV1>[];
  put(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Promise<void>;
  delete(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Promise<void>;
}

export function createRfc64FinalizedPrivatePlacementRepairStoreV1(
  operations: Rfc64FinalizedPrivatePlacementRepairOperationsV1,
): Rfc64FinalizedPrivatePlacementRepairStoreV1 {
  return Object.freeze({
    list: () => operations.listFinalizedPrivatePlacementRepairs(),
    put: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
      operations.putFinalizedPrivatePlacementRepair(repair);
    },
    delete: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
      operations.deleteFinalizedPrivatePlacementRepair(repair);
    },
  });
}

export function snapshotRfc64FinalizedPrivatePlacementRepairV1(
  input: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): Readonly<Rfc64FinalizedPrivatePlacementRepairV1> {
  if (input.version !== 1) throw new TypeError('RFC-64 placement repair version is invalid');
  assertContextGraphIdV1(input.contextGraphId, 'placement repair contextGraphId');
  assertCanonicalEvmAddress(input.authorAddress, 'placement repair authorAddress');
  assertSwmAuthorInventoryScopeV1(input.inventoryScope);
  if (input.inventoryScope.authorAddress !== input.authorAddress) {
    throw new TypeError('RFC-64 placement repair inventory scope author differs');
  }
  if (input.inventoryScope.contextGraphId !== input.contextGraphId) {
    throw new TypeError('RFC-64 placement repair inventory scope graph differs');
  }
  assertAssertionCoordinateV1(input.assertionCoordinate, 'placement repair assertionCoordinate');
  parseCanonicalDecimalU64(input.assertionVersion, 'placement repair assertionVersion');
  if (BigInt(input.assertionVersion) < 1n) {
    throw new TypeError('RFC-64 placement repair assertionVersion must be positive');
  }
  const canonicalUal = assertCanonicalDeterministicUalV1(input.kaUal);
  assertCanonicalDigest(input.sealDigest, 'placement repair sealDigest');
  return Object.freeze({
    version: 1,
    contextGraphId: input.contextGraphId,
    authorAddress: input.authorAddress,
    inventoryScope: Object.freeze({ ...input.inventoryScope }),
    assertionCoordinate: input.assertionCoordinate,
    assertionVersion: input.assertionVersion,
    kaUal: canonicalUal.ual,
    sealDigest: input.sealDigest,
  });
}

/** Canonical row bytes and digest used as the SQLite queue identity. */
export function encodeRfc64FinalizedPrivatePlacementRepairV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): Uint8Array {
  return UTF8_ENCODER.encode(`${JSON.stringify(snapshotRfc64FinalizedPrivatePlacementRepairV1(repair))}\n`);
}

export function digestRfc64FinalizedPrivatePlacementRepairV1(
  repairBytes: Uint8Array,
): Uint8Array {
  return new Uint8Array(createHash('sha256').update(repairBytes).digest());
}

export function parseRfc64FinalizedPrivatePlacementRepairV1(
  bytes: Uint8Array,
): Readonly<Rfc64FinalizedPrivatePlacementRepairV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new Error('RFC-64 finalized-private placement repair is not valid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFC-64 finalized-private placement repair is malformed');
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = [
    'assertionCoordinate', 'assertionVersion', 'authorAddress', 'contextGraphId',
    'inventoryScope', 'kaUal', 'sealDigest', 'version',
  ];
  if (Object.keys(value).sort().join('\n') !== expectedKeys.join('\n')) {
    throw new Error('RFC-64 finalized-private placement repair has unknown fields');
  }
  return snapshotRfc64FinalizedPrivatePlacementRepairV1(
    value as unknown as Rfc64FinalizedPrivatePlacementRepairV1,
  );
}
