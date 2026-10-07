// SPDX-License-Identifier: Apache-2.0

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  compareAuthorCatalogKaIdsV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AssertionCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';

import { mapRfc64CpuSlicedV1 } from './cpu-slice-v1.js';

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
  return canonicalizeOwnedAsset(ownAssetInput(input, label));
}

interface OwnedAssetInput {
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly projectionBytes: Uint8Array;
  readonly seal: Readonly<Record<string, unknown>>;
}

function ownAssetInput(input: unknown, label: string): OwnedAssetInput {
  const record = snapshotPlainDataRecordV1(input, label);
  assertExactFieldSetV1(record, ['assertionCoordinate', 'projectionBytes', 'seal'], label);
  if (!(record.projectionBytes instanceof Uint8Array)) {
    throw new TypeError(`${label}.projectionBytes must be a Uint8Array`);
  }
  const seal = snapshotPlainDataRecordV1(record.seal, `${label}.seal`, true);
  if (Object.values(seal).some((value) => value !== null && typeof value === 'object')) {
    throw new TypeError(`${label}.seal must contain primitive fields`);
  }
  return Object.freeze({
    assertionCoordinate: record.assertionCoordinate as AssertionCoordinateV1,
    projectionBytes: new Uint8Array(record.projectionBytes),
    seal,
  });
}

function canonicalizeOwnedAsset(owned: OwnedAssetInput): Readonly<Rfc64PublicCatalogSuccessorAssetInputV1> {
  assertCanonicalGraphScopedAuthorSealV1(owned.seal);
  return Object.freeze({
    assertionCoordinate: owned.assertionCoordinate,
    projectionBytes: owned.projectionBytes,
    seal: parseCanonicalGraphScopedAuthorSealV1(canonicalizeCanonicalGraphScopedAuthorSealV1(owned.seal)),
  });
}

export function snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
  input: unknown,
  label = 'RFC-64 catalog successor assets',
): readonly Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[] {
  const result = snapshotAssetInputs(input, label).map(canonicalizeOwnedAsset);
  return sortExactAssets(result, label);
}

/** Own every caller byte and primitive seal field before the first yield. */
export async function snapshotAndSortRfc64PublicCatalogSuccessorAssetsSlicedV1(
  input: unknown,
  label = 'RFC-64 catalog successor assets',
  signal?: AbortSignal,
): Promise<readonly Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[]> {
  const owned = snapshotAssetInputs(input, label);
  const result = await mapRfc64CpuSlicedV1(owned, canonicalizeOwnedAsset, signal);
  return sortExactAssets(result, label);
}

function snapshotAssetInputs(input: unknown, label: string): OwnedAssetInput[] {
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
  const owned: OwnedAssetInput[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`${label} must contain only enumerable data elements`);
    }
    owned.push(ownAssetInput(descriptor.value, `${label}[${index}]`));
  }
  return owned;
}

function sortExactAssets(
  result: Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[],
  label: string,
): readonly Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[] {
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
