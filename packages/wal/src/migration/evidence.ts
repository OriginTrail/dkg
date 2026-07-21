import { blake3 } from '@noble/hashes/blake3.js';
import { encodeCanonicalCbor } from '../protocol/canonical-cbor.js';
import { migrationError } from './errors.js';
import type { WalBackfillEvidenceManifestV1, WalBackfillPathV1 } from './types.js';

const EVIDENCE_DOMAIN = new TextEncoder().encode('dkg-wal-backfill-evidence-v1\0');
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function fixed(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be exactly 32 bytes`);
  }
  return new Uint8Array(value);
}

function text(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.normalize('NFC') !== value) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be non-empty NFC text of at most 256 characters`);
  }
  return value;
}

function sample(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_U64) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be a positive u64 microsecond duration`);
  }
  return value;
}

function p95(values: readonly bigint[], label: string): bigint {
  if (!Array.isArray(values) || values.length < 3) {
    migrationError('WAL_MIGRATION_INVALID', `${label} requires at least three samples`);
  }
  const sorted = values.map((value, index) => sample(value, `${label}[${index}]`))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

/** Machine-readable WAL-018 receipt; WAL-022 supplies the production-scale runner. */
export function createWalBackfillEvidenceManifestV1(input: {
  readonly implementationCommit: string;
  readonly environmentDigest: Uint8Array;
  readonly configurationDigest: Uint8Array;
  readonly datasetDigest: Uint8Array;
  readonly targetVectorId: Uint8Array;
  readonly path: WalBackfillPathV1;
  readonly baselineDurationsMicros: readonly bigint[];
  readonly backfillDurationsMicros: readonly bigint[];
  readonly networkPayloadBytes: bigint;
  readonly admittedObjects: bigint;
}): WalBackfillEvidenceManifestV1 {
  const baselineP95Micros = p95(input.baselineDurationsMicros, 'baselineDurationsMicros');
  const backfillP95Micros = p95(input.backfillDurationsMicros, 'backfillDurationsMicros');
  if (typeof input.networkPayloadBytes !== 'bigint' || input.networkPayloadBytes < 0n || input.networkPayloadBytes > MAX_U64) {
    migrationError('WAL_MIGRATION_INVALID', 'networkPayloadBytes must be u64');
  }
  if (typeof input.admittedObjects !== 'bigint' || input.admittedObjects < 0n || input.admittedObjects > MAX_U64) {
    migrationError('WAL_MIGRATION_INVALID', 'admittedObjects must be u64');
  }
  const paths: readonly WalBackfillPathV1[] = [
    'INCREMENTAL', 'SNAPSHOT_PLUS_DELTA', 'GENESIS_BOOTSTRAP', 'PROJECTION_REBUILD',
  ];
  if (!paths.includes(input.path)) migrationError('WAL_MIGRATION_INVALID', 'backfill evidence path is unsupported');
  const canonicalBytes = encodeCanonicalCbor([
    1n,
    text(input.implementationCommit, 'implementationCommit'),
    fixed(input.environmentDigest, 'environmentDigest'),
    fixed(input.configurationDigest, 'configurationDigest'),
    fixed(input.datasetDigest, 'datasetDigest'),
    fixed(input.targetVectorId, 'targetVectorId'),
    input.path,
    input.baselineDurationsMicros,
    input.backfillDurationsMicros,
    baselineP95Micros,
    backfillP95Micros,
    input.networkPayloadBytes,
    input.admittedObjects,
    backfillP95Micros <= baselineP95Micros,
  ]);
  const prefixed = new Uint8Array(EVIDENCE_DOMAIN.length + canonicalBytes.length);
  prefixed.set(EVIDENCE_DOMAIN);
  prefixed.set(canonicalBytes, EVIDENCE_DOMAIN.length);
  return {
    canonicalBytes,
    digest: blake3(prefixed),
    baselineP95Micros,
    backfillP95Micros,
    meetsP95: backfillP95Micros <= baselineP95Micros,
  };
}
