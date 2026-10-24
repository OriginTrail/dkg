import {
  parseDeterministicKnowledgeAssetUal,
  type Digest32V1,
} from '@origintrail-official/dkg-core';

/**
 * Serialize the production exactInventoryReadback result at the adapter
 * boundary. Lifecycle receipts are preserved for both populated and empty
 * inventory responses.
 */
export function wireSynchronizationEvidence(output: unknown): unknown {
  if (output === null) return null;
  const evidence = plainRecord(output, 'exact synchronization evidence');
  const lifecycleReceipts = Object.freeze(plainArray(
    evidence.finalizedSwmRetirementLifecycleReceipts ?? [],
    'synchronization.finalizedSwmRetirementLifecycleReceipts',
  ).map((value, index) => plainRecord(value, `synchronization lifecycle ${index}`)));
  if (evidence.inventoryRowCount === 0) {
    return Object.freeze({
      ...evidence,
      finalizedSwmRetirementLifecycleReceipts: lifecycleReceipts,
    });
  }
  const wired = evidence.inventoryRowCount === 1
    ? [wireLegacySingleRowSynchronizationEvidence(evidence)]
    : plainArray(evidence.rows, 'synchronization.rows').map(
      (value, index) => wireMultiRowSynchronizationEvidence(value, index),
    );
  const verifiedControlObjectCount = requireUniformControlObjectCount(wired);
  return Object.freeze({
    inventoryDigest: evidence.inventoryDigest,
    catalogHeadDigest: evidence.catalogHeadDigest,
    inventoryRowCount: evidence.inventoryRowCount,
    activatedTripleCount: evidence.activatedTripleCount,
    appliedHeadStatus: evidence.appliedHeadStatus,
    rows: Object.freeze(wired.map((entry) => entry.row)),
    verifiedControlObjectCount,
    finalizedSwmRetirementLifecycleReceipts: lifecycleReceipts,
  });
}

interface WiredSynchronizationRow {
  readonly row: Readonly<Record<string, unknown>>;
  readonly verifiedControlObjectCount: number;
}

function wireLegacySingleRowSynchronizationEvidence(
  evidence: Record<string, unknown>,
): WiredSynchronizationRow {
  const label = 'synchronization.legacySingleRow';
  const kaUal = requiredString(evidence.kaUal, `${label}.kaUal`);
  return wireSynchronizationRow(
    evidence,
    label,
    canonicalDecimalWire(packedKaIdFromUal(kaUal), `${label}.kaId`),
    null,
  );
}

function wireMultiRowSynchronizationEvidence(
  value: unknown,
  index: number,
): WiredSynchronizationRow {
  const label = `synchronization.rows[${index}]`;
  const row = plainRecord(value, label);
  return wireSynchronizationRow(
    row,
    label,
    canonicalDecimalWire(row.kaId, `${label}.kaId`),
    requiredDigest(row.sealDigest, `${label}.sealDigest`),
  );
}

function wireSynchronizationRow(
  row: Record<string, unknown>,
  label: string,
  kaId: string,
  sealDigest: Digest32V1 | null,
): WiredSynchronizationRow {
  const authorship = plainRecord(row.authorship, `${label}.authorship`);
  const path = plainArray(
    authorship.directoryPathObjectDigests,
    `${label}.authorship.directoryPathObjectDigests`,
  );
  const variants = plainArray(
    authorship.directoryPathSignatureVariantDigests,
    `${label}.authorship.directoryPathSignatureVariantDigests`,
  );
  if (path.length !== variants.length) {
    throw new Error('synchronization authorship path evidence is incomplete');
  }
  return Object.freeze({
    row: Object.freeze({
      kaId,
      catalogRowDigest: row.catalogRowDigest,
      contentDigest: row.contentDigest,
      sealDigest,
      bundleDigest: row.bundleDigest,
      kaUal: requiredString(row.kaUal, `${label}.kaUal`),
      activatedTripleCount: row.activatedTripleCount,
      swmGraph: row.swmGraph,
    }),
    verifiedControlObjectCount: 3 + path.length,
  });
}

function requireUniformControlObjectCount(
  rows: readonly WiredSynchronizationRow[],
): number {
  const first = rows[0];
  if (first === undefined) {
    throw new Error('non-empty synchronization evidence contains no exact rows');
  }
  for (const row of rows.slice(1)) {
    if (row.verifiedControlObjectCount !== first.verifiedControlObjectCount) {
      throw new Error('synchronization rows disagree on the verified control-object closure');
    }
  }
  return first.verifiedControlObjectCount;
}

function packedKaIdFromUal(kaUal: string): string {
  const parsed = parseDeterministicKnowledgeAssetUal(kaUal);
  return ((BigInt(parsed.agentAddress) << 96n) | BigInt(parsed.kaNumber)).toString();
}

function canonicalDecimalWire(value: unknown, label: string): string {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  throw new TypeError(`${label} is not a canonical non-negative integer`);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function plainArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new TypeError(`${label} must be a bounded Array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): Digest32V1 {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical digest`);
  }
  return value as Digest32V1;
}
