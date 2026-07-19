// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded exact-set completion for one RFC-64 public author catalog.
 *
 * Signed bucket verification establishes the expected row set. Semantic
 * activation independently produces one exact post-read row per KA. This
 * module is the join between those two facts: it rejects missing, duplicate,
 * extra, or mismatched rows before minting deterministic inventory evidence.
 *
 * Gate 2 deliberately stays inside one canonical v1 bucket (at most 1,024
 * rows). Directory-tree expansion is a later, orthogonal capacity slice.
 */

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertAuthorCatalogScopeV1,
  assertCanonicalDigest,
  assertCanonicalKaId,
  compareAuthorCatalogKaIdsV1,
  computeAuthorCatalogScopeDigestV1,
  parseCanonicalDecimalU64,
  parseDeterministicKnowledgeAssetUal,
  type AuthorCatalogScopeV1,
  type CountV1,
  type Digest32V1,
  type KaIdV1,
} from '@origintrail-official/dkg-core';
import { sha256 } from '@noble/hashes/sha2.js';
import { ethers } from 'ethers';

const UTF8 = new TextEncoder();
const APPLIED_INVENTORY_DIGEST_DOMAIN_V1 = 'dkg-rfc64-applied-inventory-v1\n';

export type Rfc64PublicCatalogInventoryCompletenessErrorCodeV1 =
  | 'catalog-inventory-completeness-input'
  | 'catalog-inventory-completeness-count'
  | 'catalog-inventory-completeness-order'
  | 'catalog-inventory-completeness-duplicate'
  | 'catalog-inventory-completeness-missing'
  | 'catalog-inventory-completeness-extra'
  | 'catalog-inventory-completeness-mismatch';

export class Rfc64PublicCatalogInventoryCompletenessErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogInventoryCompletenessErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogInventoryCompletenessErrorV1';
  }
}

/** One exact semantic post-read, keyed by the signed catalog row's KA ID. */
export interface Rfc64PublicCatalogInventoryEvidenceRowV1 {
  readonly kaId: KaIdV1;
  readonly catalogRowDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  readonly sealDigest: Digest32V1;
  /** Exact `row.transfer.blobDigest`, exposed directly for operator evidence. */
  readonly bundleDigest: Digest32V1;
  readonly kaUal: string;
  readonly activatedTripleCount: number;
}

/** Deterministic evidence for one complete bounded catalog live set. */
export interface Rfc64PublicCatalogInventoryCompletenessEvidenceV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly inventoryRowCount: CountV1;
  readonly inventoryDigest: Digest32V1;
  /** Strictly increasing by mathematical `kaId`. */
  readonly rows: readonly Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>[];
}

export interface VerifyRfc64PublicCatalogInventoryCompletenessInputV1 {
  readonly catalogScope: AuthorCatalogScopeV1;
  /** Exact `AuthorCatalogHeadV1.totalRows` value. */
  readonly expectedTotalRows: CountV1;
  /** Signed expected set. It must already be in canonical numeric KA-ID order. */
  readonly expectedRows: readonly Rfc64PublicCatalogInventoryEvidenceRowV1[];
  /** Independently observed exact semantic post-reads; input order is irrelevant. */
  readonly observedRows: readonly Rfc64PublicCatalogInventoryEvidenceRowV1[];
}

/**
 * Verify exact bounded set equality and return deterministic completion evidence.
 *
 * The digest framing intentionally matches Gate 1's one-row applied-inventory
 * digest. Gate 2 only freezes the previously-unobservable multi-row ordering:
 * numeric `kaId`, matching the signed bucket contract, never lexical UAL order.
 */
export function verifyRfc64PublicCatalogInventoryCompletenessV1(
  input: VerifyRfc64PublicCatalogInventoryCompletenessInputV1,
): Rfc64PublicCatalogInventoryCompletenessEvidenceV1 {
  let scope: Readonly<AuthorCatalogScopeV1>;
  let expectedCount: bigint;
  try {
    scope = snapshotScope(input?.catalogScope);
    expectedCount = parseCanonicalDecimalU64(
      input?.expectedTotalRows,
      'expectedTotalRows',
    );
  } catch (cause) {
    fail(
      'catalog-inventory-completeness-input',
      'catalog scope or expected row count is invalid',
      cause,
    );
  }
  if (expectedCount > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)) {
    fail(
      'catalog-inventory-completeness-count',
      `bounded catalog completion supports at most ${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} rows`,
    );
  }

  const expected = snapshotRows(input.expectedRows, scope, 'expectedRows', true);
  const observed = snapshotRows(input.observedRows, scope, 'observedRows', false);
  if (BigInt(expected.length) !== expectedCount) {
    fail(
      'catalog-inventory-completeness-count',
      `signed expected set has ${expected.length} rows but head commits ${expectedCount}`,
    );
  }

  const expectedByKaId = new Map(expected.map((row) => [row.kaId, row] as const));
  const observedByKaId = new Map(observed.map((row) => [row.kaId, row] as const));
  for (const row of expected) {
    const actual = observedByKaId.get(row.kaId);
    if (actual === undefined) {
      fail(
        'catalog-inventory-completeness-missing',
        `semantic post-read is missing expected kaId ${row.kaId}`,
      );
    }
    if (!sameRow(row, actual)) {
      fail(
        'catalog-inventory-completeness-mismatch',
        `semantic post-read differs from expected kaId ${row.kaId}`,
      );
    }
  }
  for (const row of observed) {
    if (!expectedByKaId.has(row.kaId)) {
      fail(
        'catalog-inventory-completeness-extra',
        `semantic post-read contains unexpected kaId ${row.kaId}`,
      );
    }
  }

  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  return Object.freeze({
    catalogScopeDigest,
    inventoryRowCount: input.expectedTotalRows,
    inventoryDigest: computeInventoryDigest(catalogScopeDigest, expected),
    rows: expected,
  });
}

function snapshotScope(input: AuthorCatalogScopeV1): Readonly<AuthorCatalogScopeV1> {
  const scope = {
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: input.governanceChainId,
    governanceContractAddress: input.governanceContractAddress,
    ownershipTransitionDigest: input.ownershipTransitionDigest,
    subGraphName: input.subGraphName,
    authorAddress: input.authorAddress,
    era: input.era,
    bucketCount: input.bucketCount,
  } as AuthorCatalogScopeV1;
  assertAuthorCatalogScopeV1(scope);
  return Object.freeze(scope);
}

function snapshotRows(
  input: readonly Rfc64PublicCatalogInventoryEvidenceRowV1[],
  scope: Readonly<AuthorCatalogScopeV1>,
  label: 'expectedRows' | 'observedRows',
  requireCanonicalInputOrder: boolean,
): readonly Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>[] {
  assertDenseOrdinaryArray(input, label);
  if (input.length > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    fail(
      'catalog-inventory-completeness-count',
      `${label} exceeds the ${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1}-row bucket bound`,
    );
  }

  const rows = input.map((row, index) => snapshotRow(row, scope, `${label}[${index}]`));
  assertNoDuplicateRows(rows, label);
  if (requireCanonicalInputOrder) {
    for (let index = 1; index < rows.length; index += 1) {
      if (compareAuthorCatalogKaIdsV1(rows[index - 1].kaId, rows[index].kaId) >= 0) {
        fail(
          'catalog-inventory-completeness-order',
          `${label} must be strictly increasing by mathematical kaId`,
        );
      }
    }
  } else {
    rows.sort((left, right) => compareAuthorCatalogKaIdsV1(left.kaId, right.kaId));
  }
  return Object.freeze(rows);
}

function assertNoDuplicateRows(
  rows: readonly Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>[],
  label: string,
): void {
  const seenKaIds = new Set<string>();
  const seenUals = new Set<string>();
  for (const row of rows) {
    if (seenKaIds.has(row.kaId)) {
      fail(
        'catalog-inventory-completeness-duplicate',
        `${label} contains duplicate kaId ${row.kaId}`,
      );
    }
    if (seenUals.has(row.kaUal)) {
      fail(
        'catalog-inventory-completeness-duplicate',
        `${label} contains duplicate KA UAL ${row.kaUal}`,
      );
    }
    seenKaIds.add(row.kaId);
    seenUals.add(row.kaUal);
  }
}

function snapshotRow(
  input: Rfc64PublicCatalogInventoryEvidenceRowV1,
  scope: Readonly<AuthorCatalogScopeV1>,
  label: string,
): Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1> {
  if (!isPlainRecord(input)) {
    fail('catalog-inventory-completeness-input', `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(input);
  const expectedKeys = [
    'activatedTripleCount',
    'bundleDigest',
    'catalogRowDigest',
    'contentDigest',
    'kaId',
    'kaUal',
    'sealDigest',
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    fail('catalog-inventory-completeness-input', `${label} has missing or extra fields`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      fail(
        'catalog-inventory-completeness-input',
        `${label}.${key} must be an enumerable data property`,
      );
    }
  }

  try {
    assertCanonicalKaId(input.kaId, `${label}.kaId`);
    assertCanonicalDigest(input.catalogRowDigest, `${label}.catalogRowDigest`);
    assertCanonicalDigest(input.contentDigest, `${label}.contentDigest`);
    assertCanonicalDigest(input.sealDigest, `${label}.sealDigest`);
    assertCanonicalDigest(input.bundleDigest, `${label}.bundleDigest`);
    if (!Number.isSafeInteger(input.activatedTripleCount) || input.activatedTripleCount < 1) {
      throw new Error(`${label}.activatedTripleCount must be a positive safe integer`);
    }
    const parsedUal = parseDeterministicKnowledgeAssetUal(input.kaUal);
    if (parsedUal.ual !== input.kaUal) {
      throw new Error(`${label}.kaUal is not canonical`);
    }
    if (
      parsedUal.chainId !== scope.networkId
      || parsedUal.agentAddress !== scope.authorAddress
    ) {
      throw new Error(`${label}.kaUal differs from the trusted catalog scope`);
    }
    const packedKaId = (BigInt(parsedUal.agentAddress) << 96n) | BigInt(parsedUal.kaNumber);
    if (packedKaId !== BigInt(input.kaId)) {
      throw new Error(`${label}.kaUal does not encode its signed kaId`);
    }
  } catch (cause) {
    fail(
      'catalog-inventory-completeness-input',
      `${label} is not exact canonical semantic evidence`,
      cause,
    );
  }
  return Object.freeze({
    kaId: input.kaId,
    catalogRowDigest: input.catalogRowDigest,
    contentDigest: input.contentDigest,
    sealDigest: input.sealDigest,
    bundleDigest: input.bundleDigest,
    kaUal: input.kaUal,
    activatedTripleCount: input.activatedTripleCount,
  });
}

function computeInventoryDigest(
  catalogScopeDigest: Digest32V1,
  rows: readonly Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>[],
): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(UTF8.encode(APPLIED_INVENTORY_DIGEST_DOMAIN_V1));
  hasher.update(ethers.getBytes(catalogScopeDigest));
  hasher.update(encodeU64(BigInt(rows.length), 'inventory row count'));
  for (const row of rows) {
    hasher.update(ethers.getBytes(row.catalogRowDigest));
    hasher.update(ethers.getBytes(row.contentDigest));
    hasher.update(ethers.getBytes(row.sealDigest));
    const ual = UTF8.encode(row.kaUal);
    hasher.update(encodeU64(BigInt(ual.byteLength), 'KA UAL byte length'));
    hasher.update(ual);
    hasher.update(encodeU64(BigInt(row.activatedTripleCount), 'activated triple count'));
  }
  return ethers.hexlify(hasher.digest()) as Digest32V1;
}

function encodeU64(value: bigint, label: string): Uint8Array {
  if (value < 0n || value > 18_446_744_073_709_551_615n) {
    fail('catalog-inventory-completeness-input', `${label} is outside u64`);
  }
  const result = new Uint8Array(8);
  let remaining = value;
  for (let index = result.length - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

function sameRow(
  expected: Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>,
  observed: Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>,
): boolean {
  return expected.kaId === observed.kaId
    && expected.catalogRowDigest === observed.catalogRowDigest
    && expected.contentDigest === observed.contentDigest
    && expected.sealDigest === observed.sealDigest
    && expected.bundleDigest === observed.bundleDigest
    && expected.kaUal === observed.kaUal
    && expected.activatedTripleCount === observed.activatedTripleCount;
}

function assertDenseOrdinaryArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('catalog-inventory-completeness-input', `${label} must be an ordinary Array`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== value.length + 1
    || !ownKeys.includes('length')
  ) {
    fail(
      'catalog-inventory-completeness-input',
      `${label} must be dense and contain no custom properties`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(
        'catalog-inventory-completeness-input',
        `${label} must contain only enumerable data elements`,
      );
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(
  code: Rfc64PublicCatalogInventoryCompletenessErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogInventoryCompletenessErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
