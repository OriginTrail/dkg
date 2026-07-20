import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createWalBackfillEvidenceManifestV1,
  migrationError,
  type WalBackfillPathV1,
} from '../../src/index.js';

function bytes(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-evidence-v1\0${label}`).digest());
}

function input(backfill: readonly bigint[]) {
  return {
    implementationCommit: '955af5e40',
    environmentDigest: bytes('environment'),
    configurationDigest: bytes('configuration'),
    datasetDigest: bytes('dataset'),
    targetVectorId: bytes('vector'),
    path: 'SNAPSHOT_PLUS_DELTA' as WalBackfillPathV1,
    baselineDurationsMicros: [100n, 110n, 120n, 130n, 140n],
    backfillDurationsMicros: backfill,
    networkPayloadBytes: 1_024n,
    admittedObjects: 10n,
  };
}

function evidence(backfill: readonly bigint[]) {
  return createWalBackfillEvidenceManifestV1(input(backfill));
}

describe('WAL-018 backfill evidence manifest', () => {
  it('records deterministic p95 parity evidence using integer microseconds', () => {
    const passing = evidence([90n, 100n, 110n, 120n, 130n]);
    expect(passing).toMatchObject({ baselineP95Micros: 140n, backfillP95Micros: 130n, meetsP95: true });
    expect(passing.canonicalBytes).toEqual(evidence([90n, 100n, 110n, 120n, 130n]).canonicalBytes);
    expect(passing.digest).toEqual(evidence([90n, 100n, 110n, 120n, 130n]).digest);
    expect(evidence([100n, 120n, 140n, 150n, 160n]).meetsP95).toBe(false);
    expect(evidence([2n, 1n, 2n])).toMatchObject({ backfillP95Micros: 2n });
  });

  it('requires comparable repeated positive-integer timing samples', () => {
    expect(() => evidence([1n, 2n])).toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(() => evidence([1n, 0n, 2n])).toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
  });

  it('rejects every malformed evidence coordinate, bound, path, and sample shape', () => {
    const valid = input([1n, 1n, 1n]);
    const reject = (overrides: Record<string, unknown>) => expect(() => createWalBackfillEvidenceManifestV1({
      ...valid,
      ...overrides,
    } as never)).toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    reject({ environmentDigest: 'not-bytes' });
    reject({ environmentDigest: new Uint8Array(31) });
    reject({ implementationCommit: 1 });
    reject({ implementationCommit: '' });
    reject({ implementationCommit: 'x'.repeat(257) });
    reject({ implementationCommit: 'e\u0301' });
    reject({ baselineDurationsMicros: 'not-an-array' });
    reject({ baselineDurationsMicros: [1n, 2n] });
    reject({ baselineDurationsMicros: [1 as never, 2n, 3n] });
    reject({ baselineDurationsMicros: [MAX_U64 + 1n, 2n, 3n] });
    reject({ networkPayloadBytes: 1 });
    reject({ networkPayloadBytes: -1n });
    reject({ networkPayloadBytes: MAX_U64 + 1n });
    reject({ admittedObjects: 1 });
    reject({ admittedObjects: -1n });
    reject({ admittedObjects: MAX_U64 + 1n });
    reject({ path: 'UNKNOWN' as WalBackfillPathV1 });
  });

  it('preserves an explicit error cause', () => {
    const cause = new Error('cause');
    expect(() => migrationError('WAL_MIGRATION_INVALID', 'wrapped', cause))
      .toThrow(expect.objectContaining({ cause }));
  });
});

const MAX_U64 = 0xffff_ffff_ffff_ffffn;
