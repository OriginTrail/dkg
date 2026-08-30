import type { Digest32V1 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import type { Rfc64FinalizedSwmRetirementLifecycleReceiptV1 } from
  '../../packages/agent/src/rfc64/finalized-swm-retirement-lifecycle-receipt-v1.ts';

const MAX_RECEIPTS = 1_024;
const POST_READ_DIGEST_DOMAIN_V1 = ethers.toUtf8Bytes(
  'OT-RFC-64:finalized-vm-post-read:v1\0',
);
const RECONCILIATION_OUTCOMES = Object.freeze([
  'retired',
  'already-retired-finalized',
  'head-missing-or-ambiguous',
  'head-version-mismatch',
  'vm-metadata-mismatch',
  'swm-commitment-mismatch',
  'vm-changed',
  'content-mismatch',
] as const);

export interface DecodedRetirementLifecycleReceiptsV1 {
  readonly receipts: readonly Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>[];
  readonly byUal: ReadonlyMap<
    string,
    Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>
  >;
}

/** Decode the process boundary once, preserving the complete canonical receipt contract. */
export function decodeRetirementLifecycleReceiptsV1(
  input: unknown,
): Readonly<DecodedRetirementLifecycleReceiptsV1> {
  if (!Array.isArray(input) || input.length > MAX_RECEIPTS) {
    throw new TypeError('private retirement lifecycle receipts must be a bounded array');
  }
  const byUal = new Map<
    string,
    Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>
  >();
  let previousUal: string | undefined;
  const receipts = input.map((value, index) => {
    const receipt = record(value, `private retirement lifecycle receipt ${index}`);
    const kaUal = requiredString(receipt.kaUal, `private lifecycle ${index} KA UAL`);
    if (byUal.has(kaUal)) {
      throw new Error(`private retirement lifecycle duplicates ${kaUal}`);
    }
    if (previousUal !== undefined && previousUal.localeCompare(kaUal) >= 0) {
      throw new Error(
        `private retirement lifecycle is out of canonical UAL order at ${kaUal}`,
      );
    }
    previousUal = kaUal;
    const committedHead = record(
      receipt.committedHead,
      `private lifecycle ${index} committed head`,
    );
    const subGraphName = optionalString(
      receipt.subGraphName,
      `private lifecycle ${index} subgraph`,
    );
    const decoded = Object.freeze({
      kind: exactString(
        receipt.kind,
        'rfc64-finalized-swm-retirement-lifecycle-receipt-v1',
        `private lifecycle ${index} kind`,
      ),
      catalogHeadDigest: requiredDigest(
        receipt.catalogHeadDigest,
        `private lifecycle ${index} catalog head`,
      ),
      inventoryDigest: requiredDigest(
        receipt.inventoryDigest,
        `private lifecycle ${index} inventory`,
      ),
      contextGraphId: requiredString(
        receipt.contextGraphId,
        `private lifecycle ${index} context graph`,
      ),
      ...(subGraphName === undefined ? {} : { subGraphName }),
      kaUal,
      assertionVersion: requiredString(
        receipt.assertionVersion,
        `private lifecycle ${index} assertion version`,
      ),
      vmGraphIri: requiredString(
        receipt.vmGraphIri,
        `private lifecycle ${index} VM graph`,
      ),
      vmPostReadDigest: requiredDigest(
        receipt.vmPostReadDigest,
        `private lifecycle ${index} VM post-read`,
      ),
      vmMaterializationStatus: oneOf(
        receipt.vmMaterializationStatus,
        ['materialized', 'existing'] as const,
        `private lifecycle ${index} VM materialization status`,
      ),
      committedHead: Object.freeze({
        kind: exactString(
          committedHead.kind,
          'rfc64-public-catalog-native-committed-head-token-v1',
          `private lifecycle ${index} committed-head kind`,
        ),
        catalogHeadDigest: requiredDigest(
          committedHead.catalogHeadDigest,
          `private lifecycle ${index} committed-head digest`,
        ),
        inventoryDigest: requiredDigest(
          committedHead.inventoryDigest,
          `private lifecycle ${index} committed inventory`,
        ),
      }),
      swmReconciliationOutcome: oneOf(
        receipt.swmReconciliationOutcome,
        RECONCILIATION_OUTCOMES,
        `private lifecycle ${index} SWM reconciliation outcome`,
      ),
    }) satisfies Rfc64FinalizedSwmRetirementLifecycleReceiptV1;
    byUal.set(kaUal, decoded);
    return decoded;
  });
  return Object.freeze({
    receipts: Object.freeze(receipts),
    byUal,
  });
}

/** Independently derive the production v1 post-read digest from storage-canonical N-Quads. */
export function computeFinalizedVmPostReadDigestV1(
  canonicalProjectionNQuads: string,
): Digest32V1 {
  return ethers.keccak256(ethers.concat([
    POST_READ_DIGEST_DOMAIN_V1,
    ethers.toUtf8Bytes(canonicalProjectionNQuads),
  ])).toLowerCase() as Digest32V1;
}

/**
 * Convert the process adapter's line-framed readback to the storage renderer's
 * no-trailing-newline representation before independently applying the v1
 * production digest contract.
 */
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

/** Bind a cold receiver's lifecycle receipt to its independently read VM bytes. */
export function assertColdMaterializedVmReceiptV1(
  receipt: Readonly<Rfc64FinalizedSwmRetirementLifecycleReceiptV1>,
  lineFramedProjectionNQuads: string,
): void {
  if (receipt.vmMaterializationStatus !== 'materialized') {
    throw new Error(`private lifecycle ${receipt.kaUal} did not materialize on the cold receiver`);
  }
  if (
    receipt.vmPostReadDigest
    !== computeFinalizedVmPostReadDigestFromHarnessReadbackV1(lineFramedProjectionNQuads)
  ) {
    throw new Error(`private lifecycle ${receipt.kaUal} VM post-read digest differs`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new TypeError(`${label} is missing`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredDigest(value: unknown, label: string): Digest32V1 {
  const result = requiredString(value, label);
  if (!/^0x[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${label} is not a digest`);
  return result as Digest32V1;
}

function exactString<const T extends string>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) throw new TypeError(`${label} is invalid`);
  return expected;
}

function oneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}
