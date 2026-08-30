import type { Digest32V1 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

const MAX_RECEIPTS = 1_024;
const POST_READ_DIGEST_DOMAIN_V1 = ethers.toUtf8Bytes(
  'OT-RFC-64:finalized-vm-post-read:v1\0',
);

export interface PrivateColdRetirementLifecycleReceiptV1 {
  readonly kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1';
  readonly committedHead: Readonly<{
    readonly kind: 'rfc64-public-catalog-native-committed-head-token-v1';
    readonly catalogHeadDigest: Digest32V1;
    readonly inventoryDigest: Digest32V1;
  }>;
  readonly contextGraphId: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly vmGraphIri: string;
  readonly vmPostReadDigest: Digest32V1;
  readonly vmMaterializationStatus: 'materialized';
  readonly swmReconciliationOutcome: 'retired';
}

export interface PrivateColdRetirementLifecycleExpectationV1 {
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryDigest: Digest32V1;
  readonly contextGraphId: string;
  readonly byUal: ReadonlyMap<string, Readonly<{
    readonly assertionVersion: string;
    readonly vmGraphIri: string;
    readonly lineFramedProjectionNQuads: string;
  }>>;
}

/**
 * Assert the complete CP2 PASS boundary in one pass. This intentionally models
 * only the cold, root-lane, materialized-and-retired state certified by this
 * scenario; other valid production lifecycle states are not CP2 PASS states.
 */
export function assertPrivateColdRetirementLifecycleV1(
  input: unknown,
  expected: Readonly<PrivateColdRetirementLifecycleExpectationV1>,
): Readonly<{
  readonly receipts: readonly Readonly<PrivateColdRetirementLifecycleReceiptV1>[];
  readonly byUal: ReadonlyMap<string, Readonly<PrivateColdRetirementLifecycleReceiptV1>>;
}> {
  if (
    !Array.isArray(input)
    || input.length > MAX_RECEIPTS
    || input.length !== expected.byUal.size
  ) {
    throw new TypeError('private cold retirement lifecycle must be the exact bounded asset set');
  }
  const byUal = new Map<string, Readonly<PrivateColdRetirementLifecycleReceiptV1>>();
  let previousUal: string | undefined;
  const receipts = input.map((value, index) => {
    const label = `private cold lifecycle ${index}`;
    const receipt = exactRecord(value, [
      'kind',
      'committedHead',
      'contextGraphId',
      'kaUal',
      'assertionVersion',
      'vmGraphIri',
      'vmPostReadDigest',
      'vmMaterializationStatus',
      'swmReconciliationOutcome',
    ], label);
    const kaUal = requiredString(receipt.kaUal, `${label} KA UAL`);
    const expectation = expected.byUal.get(kaUal);
    if (expectation === undefined || byUal.has(kaUal)) {
      throw new Error(`${label} has an unexpected or duplicate KA UAL ${kaUal}`);
    }
    if (previousUal !== undefined && previousUal.localeCompare(kaUal) >= 0) {
      throw new Error(`${label} is out of canonical UAL order at ${kaUal}`);
    }
    previousUal = kaUal;
    const committedHead = exactRecord(receipt.committedHead, [
      'kind',
      'catalogHeadDigest',
      'inventoryDigest',
    ], `${label} committed head`);
    const decoded = Object.freeze({
      kind: exactString(
        receipt.kind,
        'rfc64-finalized-swm-retirement-lifecycle-receipt-v1',
        `${label} kind`,
      ),
      committedHead: Object.freeze({
        kind: exactString(
          committedHead.kind,
          'rfc64-public-catalog-native-committed-head-token-v1',
          `${label} committed-head kind`,
        ),
        catalogHeadDigest: exactDigest(
          committedHead.catalogHeadDigest,
          expected.catalogHeadDigest,
          `${label} committed-head digest`,
        ),
        inventoryDigest: exactDigest(
          committedHead.inventoryDigest,
          expected.inventoryDigest,
          `${label} committed inventory`,
        ),
      }),
      contextGraphId: exactString(
        receipt.contextGraphId,
        expected.contextGraphId,
        `${label} context graph`,
      ),
      kaUal,
      assertionVersion: exactString(
        receipt.assertionVersion,
        expectation.assertionVersion,
        `${label} assertion version`,
      ),
      vmGraphIri: exactString(
        receipt.vmGraphIri,
        expectation.vmGraphIri,
        `${label} VM graph`,
      ),
      vmPostReadDigest: exactDigest(
        receipt.vmPostReadDigest,
        computeFinalizedVmPostReadDigestFromHarnessReadbackV1(
          expectation.lineFramedProjectionNQuads,
        ),
        `${label} VM post-read digest`,
      ),
      vmMaterializationStatus: exactString(
        receipt.vmMaterializationStatus,
        'materialized',
        `${label} VM materialization status`,
      ),
      swmReconciliationOutcome: exactString(
        receipt.swmReconciliationOutcome,
        'retired',
        `${label} SWM reconciliation outcome`,
      ),
    }) satisfies PrivateColdRetirementLifecycleReceiptV1;
    byUal.set(kaUal, decoded);
    return decoded;
  });
  return Object.freeze({ receipts: Object.freeze(receipts), byUal });
}

/** Independently derive the production v1 post-read digest from canonical N-Quads. */
export function computeFinalizedVmPostReadDigestV1(
  canonicalProjectionNQuads: string,
): Digest32V1 {
  return ethers.keccak256(ethers.concat([
    POST_READ_DIGEST_DOMAIN_V1,
    ethers.toUtf8Bytes(canonicalProjectionNQuads),
  ])).toLowerCase() as Digest32V1;
}

export function computeFinalizedVmPostReadDigestFromHarnessReadbackV1(
  lineFramedProjectionNQuads: string,
): Digest32V1 {
  if (
    !lineFramedProjectionNQuads.endsWith('\n')
    || lineFramedProjectionNQuads.endsWith('\n\n')
    || lineFramedProjectionNQuads.includes('\r')
  ) {
    throw new TypeError('private VM harness readback must have exactly one trailing LF');
  }
  return computeFinalizedVmPostReadDigestV1(lineFramedProjectionNQuads.slice(0, -1));
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const actualKeys = Object.keys(result).sort();
  const expectedKeys = [...keys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new TypeError(`${label} has unexpected or missing fields`);
  }
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new TypeError(`${label} is missing`);
  }
  return value;
}

function exactDigest(value: unknown, expected: Digest32V1, label: string): Digest32V1 {
  if (value !== expected) throw new TypeError(`${label} is invalid`);
  return expected;
}

function exactString<const T extends string>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) throw new TypeError(`${label} is invalid`);
  return expected;
}
