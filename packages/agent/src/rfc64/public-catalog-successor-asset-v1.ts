// SPDX-License-Identifier: Apache-2.0

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  compareAuthorCatalogKaIdsV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AssertionCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';

import {
  assertExactFieldSetV1,
  snapshotPlainDataRecordV1,
} from './inventory-v1/exact-record.js';

/** One canonical immutable asset at the shared catalog producer boundary. */
export interface Rfc64PublicCatalogSuccessorAssetInputV1 {
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly projectionBytes: Uint8Array;
  readonly seal: CanonicalGraphScopedAuthorSealV1;
}

export function snapshotRfc64PublicCatalogSuccessorAssetV1(
  input: unknown,
  label = 'RFC-64 catalog successor asset',
): Readonly<Rfc64PublicCatalogSuccessorAssetInputV1> {
  const record = snapshotPlainDataRecordV1(input, label);
  assertExactFieldSetV1(record, ['assertionCoordinate', 'projectionBytes', 'seal'], label);
  if (!(record.projectionBytes instanceof Uint8Array)) {
    throw new TypeError(`${label}.projectionBytes must be a Uint8Array`);
  }
  return Object.freeze({
    assertionCoordinate:
      record.assertionCoordinate as Rfc64PublicCatalogSuccessorAssetInputV1['assertionCoordinate'],
    projectionBytes: new Uint8Array(record.projectionBytes),
    seal: parseCanonicalGraphScopedAuthorSealV1(
      canonicalizeCanonicalGraphScopedAuthorSealV1(
        record.seal as Rfc64PublicCatalogSuccessorAssetInputV1['seal'],
      ),
    ),
  });
}

export function snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
  input: unknown,
  label = 'RFC-64 catalog successor assets',
): readonly Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary Array`);
  }
  if (input.length > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    throw new RangeError(
      `${label} exceeds ${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} assets`,
    );
  }
  const ownKeys = Reflect.ownKeys(input);
  const expectedOwnKeys = new Set<string>([
    'length',
    ...Array.from({ length: input.length }, (_value, index) => String(index)),
  ]);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== expectedOwnKeys.size
    || ownKeys.some((key) => typeof key === 'string' && !expectedOwnKeys.has(key))
  ) {
    throw new TypeError(`${label} must be a dense data array`);
  }
  const result: Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`${label} must contain only enumerable data elements`);
    }
    result.push(snapshotRfc64PublicCatalogSuccessorAssetV1(
      descriptor.value,
      `${label}[${index}]`,
    ));
  }
  result.sort((left, right) => compareAuthorCatalogKaIdsV1(
    left.seal.reservedKaId,
    right.seal.reservedKaId,
  ));
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1]!;
    const current = result[index]!;
    if (previous.seal.reservedKaId === current.seal.reservedKaId) {
      throw new Error(`${label} contains duplicate KA ${current.seal.reservedKaId}`);
    }
  }
  return Object.freeze(result);
}

export function compareRfc64PublicCatalogSuccessorAssetsByKaIdV1(
  left: Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>,
  right: Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>,
): -1 | 0 | 1 {
  return compareAuthorCatalogKaIdsV1(left.seal.reservedKaId, right.seal.reservedKaId);
}
