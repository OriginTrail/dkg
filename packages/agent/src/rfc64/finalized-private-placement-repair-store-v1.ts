// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  assertAssertionCoordinateV1,
  assertCanonicalDeterministicUalV1,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertSwmAuthorInventoryScopeV1,
  assertSubGraphNameV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  parseCanonicalGraphScopedAuthorSealV1,
  parseCanonicalDecimalU64,
  type AssertionCoordinateV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type PositiveDecimalU64V1,
  type SwmAuthorInventoryScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';

import type { Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 } from
  './swm-author-inventory-producer-v1.js';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface LegacyFinalizedPrivatePlacementRepairV1
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

/** Scope-independent confirmation evidence, atomically stored with its immutable seal. */
interface ConfirmedCatalogPlacementRepairV2 extends Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 {
  readonly version: 2;
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  readonly inventoryScope: null;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
}

/** V1 stays readable and retains its confirmation-time policy fence. New writes use V2. */
export type Rfc64FinalizedPrivatePlacementRepairV1 =
  | LegacyFinalizedPrivatePlacementRepairV1
  | ConfirmedCatalogPlacementRepairV2;

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
  if (input.version !== 1 && input.version !== 2) throw new TypeError('RFC-64 placement repair version is invalid');
  assertContextGraphIdV1(input.contextGraphId, 'placement repair contextGraphId');
  assertCanonicalEvmAddress(input.authorAddress, 'placement repair authorAddress');
  if (input.version === 1) {
    assertSwmAuthorInventoryScopeV1(input.inventoryScope);
    if (input.inventoryScope.authorAddress !== input.authorAddress
      || input.inventoryScope.contextGraphId !== input.contextGraphId) {
      throw new TypeError('RFC-64 placement repair inventory scope differs');
    }
  } else {
    if (input.inventoryScope !== null) throw new TypeError('RFC-64 confirmed placement must be scope-independent');
    if (input.subGraphName !== null) assertSubGraphNameV1(input.subGraphName);
  }
  assertAssertionCoordinateV1(input.assertionCoordinate, 'placement repair assertionCoordinate');
  parseCanonicalDecimalU64(input.assertionVersion, 'placement repair assertionVersion');
  if (BigInt(input.assertionVersion) < 1n) {
    throw new TypeError('RFC-64 placement repair assertionVersion must be positive');
  }
  const canonicalUal = assertCanonicalDeterministicUalV1(input.kaUal);
  assertCanonicalDigest(input.sealDigest, 'placement repair sealDigest');
  const identity = {
    contextGraphId: input.contextGraphId, authorAddress: input.authorAddress,
    assertionCoordinate: input.assertionCoordinate, assertionVersion: input.assertionVersion,
    kaUal: canonicalUal.ual, sealDigest: input.sealDigest,
  };
  if (input.version === 2) {
    const seal = Object.freeze(parseCanonicalGraphScopedAuthorSealV1(
      canonicalizeCanonicalGraphScopedAuthorSealV1(input.seal),
    ));
    if (seal.authorAddress !== input.authorAddress || seal.kaUal !== identity.kaUal
      || seal.assertionVersion !== identity.assertionVersion
      || computeCanonicalGraphScopedAuthorSealDigestV1(seal) !== identity.sealDigest) {
      throw new TypeError('RFC-64 confirmed placement seal differs from its identity');
    }
    return Object.freeze({ ...identity, version: 2, inventoryScope: null,
      subGraphName: input.subGraphName, seal });
  }
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
  const bytes = UTF8_ENCODER.encode(`${JSON.stringify(snapshotRfc64FinalizedPrivatePlacementRepairV1(repair))}\n`);
  if (repair.version === 2 && bytes.byteLength > 8192) {
    throw new TypeError('RFC-64 confirmed placement exceeds the inventory record byte bound');
  }
  return bytes;
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
    ...(value.version === 2 ? ['seal', 'subGraphName'] : []),
  ].sort();
  if (Object.keys(value).sort().join('\n') !== expectedKeys.join('\n')) {
    throw new Error('RFC-64 finalized-private placement repair has unknown fields');
  }
  return snapshotRfc64FinalizedPrivatePlacementRepairV1(
    value as unknown as Rfc64FinalizedPrivatePlacementRepairV1,
  );
}
