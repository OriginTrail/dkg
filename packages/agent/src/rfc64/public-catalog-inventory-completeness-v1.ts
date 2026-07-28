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
  | 'catalog-inventory-completeness-slice'
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

/**
 * Exact row fields committed by the durable applied-inventory digest.
 *
 * `kaId` is an ordering key and is not itself hashed. It is nevertheless
 * required so every caller uses the signed catalog's mathematical KA-ID order;
 * deriving order from lexical UAL text is not equivalent for IDs such as 2 and
 * 10. `bundleDigest` remains operator evidence outside this legacy commitment,
 * so callers may pass richer receiver evidence rows without affecting the hash.
 */
export interface Rfc64AppliedInventoryDigestRowV1 {
  readonly kaId: KaIdV1;
  readonly catalogRowDigest: Digest32V1;
  readonly contentDigest: Digest32V1;
  readonly sealDigest: Digest32V1;
  readonly kaUal: string;
  readonly activatedTripleCount: number;
}

export interface ComputeRfc64AppliedInventoryDigestInputV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly rows: readonly Rfc64AppliedInventoryDigestRowV1[];
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
 * Compute the one canonical applied-inventory commitment for empty, one-row,
 * and bounded multi-row catalogs.
 *
 * Input rows are snapshotted and validated, then sorted by mathematical
 * `kaId`. Caller order is irrelevant. This preserves the Gate-1 empty/one-row
 * framing while making the previously unobservable multi-row order explicit.
 */
export function computeRfc64AppliedInventoryDigestV1(
  input: ComputeRfc64AppliedInventoryDigestInputV1,
): Digest32V1 {
  const boundary = snapshotExactDataRecord(input, [
    'catalogScopeDigest',
    'rows',
  ], 'applied inventory digest input');
  try {
    assertCanonicalDigest(boundary.catalogScopeDigest, 'catalogScopeDigest');
  } catch (cause) {
    fail(
      'catalog-inventory-completeness-input',
      'catalogScopeDigest is not a canonical digest',
      cause,
    );
  }
  const rows = snapshotAppliedInventoryDigestRows(boundary.rows);
  const hasher = sha256.create();
  hasher.update(UTF8.encode(APPLIED_INVENTORY_DIGEST_DOMAIN_V1));
  hasher.update(ethers.getBytes(boundary.catalogScopeDigest as Digest32V1));
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
  const boundary = snapshotTopLevelInput(input);
  let scope: Readonly<AuthorCatalogScopeV1>;
  let expectedCount: bigint;
  try {
    scope = snapshotScope(boundary.catalogScope);
    expectedCount = parseCanonicalDecimalU64(
      boundary.expectedTotalRows,
      'expectedTotalRows',
    );
  } catch (cause) {
    fail(
      'catalog-inventory-completeness-input',
      'catalog scope or expected row count is invalid',
      cause,
    );
  }
  if (scope.bucketCount !== '1') {
    fail(
      'catalog-inventory-completeness-slice',
      'bounded Gate-2 catalog completion requires exactly one signed bucket',
    );
  }
  if (
    expectedCount < 1n
    || expectedCount > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)
  ) {
    fail(
      'catalog-inventory-completeness-count',
      `bounded catalog completion supports 1..${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} rows`,
    );
  }

  const expected = snapshotRows(boundary.expectedRows, scope, 'expectedRows', true);
  const observed = snapshotRows(boundary.observedRows, scope, 'observedRows', false);
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
    inventoryRowCount: boundary.expectedTotalRows,
    inventoryDigest: computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: expected,
    }),
    rows: expected,
  });
}

function snapshotTopLevelInput(
  input: VerifyRfc64PublicCatalogInventoryCompletenessInputV1,
): Readonly<VerifyRfc64PublicCatalogInventoryCompletenessInputV1> {
  const fields = snapshotExactDataRecord(input, [
    'catalogScope',
    'expectedRows',
    'expectedTotalRows',
    'observedRows',
  ], 'inventory completeness input');
  return Object.freeze({
    catalogScope: fields.catalogScope as AuthorCatalogScopeV1,
    expectedTotalRows: fields.expectedTotalRows as CountV1,
    expectedRows: fields.expectedRows as readonly Rfc64PublicCatalogInventoryEvidenceRowV1[],
    observedRows: fields.observedRows as readonly Rfc64PublicCatalogInventoryEvidenceRowV1[],
  });
}

function snapshotScope(input: AuthorCatalogScopeV1): Readonly<AuthorCatalogScopeV1> {
  const fields = snapshotExactDataRecord(input, [
    'authorAddress',
    'bucketCount',
    'contextGraphId',
    'era',
    'governanceChainId',
    'governanceContractAddress',
    'networkId',
    'ownershipTransitionDigest',
    'subGraphName',
  ], 'catalogScope');
  const scope = Object.freeze({
    networkId: fields.networkId,
    contextGraphId: fields.contextGraphId,
    governanceChainId: fields.governanceChainId,
    governanceContractAddress: fields.governanceContractAddress,
    ownershipTransitionDigest: fields.ownershipTransitionDigest,
    subGraphName: fields.subGraphName,
    authorAddress: fields.authorAddress,
    era: fields.era,
    bucketCount: fields.bucketCount,
  } as AuthorCatalogScopeV1);
  assertAuthorCatalogScopeV1(scope);
  return scope;
}

function snapshotRows(
  input: readonly Rfc64PublicCatalogInventoryEvidenceRowV1[],
  scope: Readonly<AuthorCatalogScopeV1>,
  label: 'expectedRows' | 'observedRows',
  requireCanonicalInputOrder: boolean,
): readonly Readonly<Rfc64PublicCatalogInventoryEvidenceRowV1>[] {
  const values = snapshotDenseBoundedOrdinaryArray(input, label);
  const rows = values.map((row, index) => snapshotRow(
    row as Rfc64PublicCatalogInventoryEvidenceRowV1,
    scope,
    `${label}[${index}]`,
  ));
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
  const fields = snapshotExactDataRecord(input, [
    'activatedTripleCount',
    'bundleDigest',
    'catalogRowDigest',
    'contentDigest',
    'kaId',
    'kaUal',
    'sealDigest',
  ], label);
  const snapshot = Object.freeze({
    kaId: fields.kaId,
    catalogRowDigest: fields.catalogRowDigest,
    contentDigest: fields.contentDigest,
    sealDigest: fields.sealDigest,
    bundleDigest: fields.bundleDigest,
    kaUal: fields.kaUal,
    activatedTripleCount: fields.activatedTripleCount,
  }) as unknown as Rfc64PublicCatalogInventoryEvidenceRowV1;

  try {
    assertCanonicalKaId(snapshot.kaId, `${label}.kaId`);
    assertCanonicalDigest(snapshot.catalogRowDigest, `${label}.catalogRowDigest`);
    assertCanonicalDigest(snapshot.contentDigest, `${label}.contentDigest`);
    assertCanonicalDigest(snapshot.sealDigest, `${label}.sealDigest`);
    assertCanonicalDigest(snapshot.bundleDigest, `${label}.bundleDigest`);
    if (
      !Number.isSafeInteger(snapshot.activatedTripleCount)
      || snapshot.activatedTripleCount < 1
    ) {
      throw new Error(`${label}.activatedTripleCount must be a positive safe integer`);
    }
    const parsedUal = parseDeterministicKnowledgeAssetUal(snapshot.kaUal);
    if (parsedUal.ual !== snapshot.kaUal) {
      throw new Error(`${label}.kaUal is not canonical`);
    }
    if (
      parsedUal.chainId !== scope.networkId
      || parsedUal.agentAddress !== scope.authorAddress
    ) {
      throw new Error(`${label}.kaUal differs from the trusted catalog scope`);
    }
    const packedKaId = (BigInt(parsedUal.agentAddress) << 96n) | BigInt(parsedUal.kaNumber);
    if (packedKaId !== BigInt(snapshot.kaId)) {
      throw new Error(`${label}.kaUal does not encode its signed kaId`);
    }
  } catch (cause) {
    fail(
      'catalog-inventory-completeness-input',
      `${label} is not exact canonical semantic evidence`,
      cause,
    );
  }
  return snapshot;
}

function snapshotAppliedInventoryDigestRows(
  input: unknown,
): readonly Readonly<Rfc64AppliedInventoryDigestRowV1>[] {
  const values = snapshotDenseBoundedOrdinaryArray(input, 'applied inventory digest rows');
  const rows = values.map((value, index) => {
    const label = `applied inventory digest rows[${index}]`;
    const fields = snapshotRequiredDataRecord(value, [
      'activatedTripleCount',
      'catalogRowDigest',
      'contentDigest',
      'kaId',
      'kaUal',
      'sealDigest',
    ], label);
    const row = Object.freeze({
      kaId: fields.kaId,
      catalogRowDigest: fields.catalogRowDigest,
      contentDigest: fields.contentDigest,
      sealDigest: fields.sealDigest,
      kaUal: fields.kaUal,
      activatedTripleCount: fields.activatedTripleCount,
    }) as unknown as Rfc64AppliedInventoryDigestRowV1;
    try {
      assertCanonicalKaId(row.kaId, `${label}.kaId`);
      assertCanonicalDigest(row.catalogRowDigest, `${label}.catalogRowDigest`);
      assertCanonicalDigest(row.contentDigest, `${label}.contentDigest`);
      assertCanonicalDigest(row.sealDigest, `${label}.sealDigest`);
      if (!Number.isSafeInteger(row.activatedTripleCount) || row.activatedTripleCount < 1) {
        throw new Error(`${label}.activatedTripleCount must be a positive safe integer`);
      }
      const parsedUal = parseDeterministicKnowledgeAssetUal(row.kaUal);
      const packedKaId = (BigInt(parsedUal.agentAddress) << 96n) | BigInt(parsedUal.kaNumber);
      if (parsedUal.ual !== row.kaUal || packedKaId !== BigInt(row.kaId)) {
        throw new Error(`${label}.kaUal does not canonically encode kaId`);
      }
    } catch (cause) {
      fail(
        'catalog-inventory-completeness-input',
        `${label} is not exact canonical digest evidence`,
        cause,
      );
    }
    return row;
  });
  rows.sort((left, right) => compareAuthorCatalogKaIdsV1(left.kaId, right.kaId));
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1]!.kaId === rows[index]!.kaId) {
      fail(
        'catalog-inventory-completeness-duplicate',
        `applied inventory digest rows contain duplicate kaId ${rows[index]!.kaId}`,
      );
    }
  }
  return Object.freeze(rows);
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

function snapshotDenseBoundedOrdinaryArray(
  value: unknown,
  label: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      fail('catalog-inventory-completeness-input', `${label} must be an ordinary Array`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined
      || lengthDescriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      fail('catalog-inventory-completeness-input', `${label}.length is not an exact data field`);
    }
    const length = lengthDescriptor.value;
    // Enforce the work ceiling before enumerating or copying caller rows.
    if (length > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
      fail(
        'catalog-inventory-completeness-count',
        `${label} exceeds the ${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1}-row bucket bound`,
      );
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string')
      || ownKeys.length !== length + 1
      || !ownKeys.includes('length')
    ) {
      fail(
        'catalog-inventory-completeness-input',
        `${label} must be dense and contain no custom properties`,
      );
    }
    const snapshot = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail(
          'catalog-inventory-completeness-input',
          `${label} must contain only enumerable data elements`,
        );
      }
      snapshot[index] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogInventoryCompletenessErrorV1) throw cause;
    fail(
      'catalog-inventory-completeness-input',
      `${label} could not be snapshotted exactly`,
      cause,
    );
  }
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (!isPlainRecord(value)) {
      fail('catalog-inventory-completeness-input', `${label} must be a plain object`);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      fail(
        'catalog-inventory-completeness-input',
        `${label} has missing or extra fields`,
      );
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
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
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogInventoryCompletenessErrorV1) throw cause;
    fail(
      'catalog-inventory-completeness-input',
      `${label} could not be snapshotted exactly`,
      cause,
    );
  }
}

/**
 * Snapshot only the fields committed by a projection. Richer product evidence
 * may carry additional data, but it is neither enumerated nor read here.
 */
function snapshotRequiredDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    if (!isPlainRecord(value)) {
      fail('catalog-inventory-completeness-input', `${label} must be a plain object`);
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of requiredKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
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
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogInventoryCompletenessErrorV1) throw cause;
    fail(
      'catalog-inventory-completeness-input',
      `${label} could not be snapshotted exactly`,
      cause,
    );
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
