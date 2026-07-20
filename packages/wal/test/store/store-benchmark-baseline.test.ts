import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Baseline {
  schema: string;
  executionModel: string;
  fixturePolicy: string;
  sizes: number[];
  repetitions: number;
  maximumTimeRegressionRatio: number;
  results: Array<{
    objectCount: number;
    fixtureMode: string;
    inventoryPreparationMs: number;
    enumerate: { objects: number; totalMs: number };
    hasHit: { operations: number; p95Ms: number };
    hasMiss: { operations: number; p95Ms: number };
    fullRead: { operations: number; bytes: number };
    rangedRead: { operations: number; bytes: number };
    verifiedAdmission: { operations: number; bytes: number; p95Ms: number };
    idempotentAdmission: { operations: number; p95Ms: number };
    largeObject: { payloadBytes: number; canonicalBytes: number; putMs: number; fullReadMs: number; rangedReadMs: number };
    rangeReassembly: { canonicalBytes: number; ranges: number; totalMs: number };
    totalMs: number;
    cpu: { userMicros: number; systemMicros: number };
    memory: { maxRssBytes: number };
  }>;
  summaries: Array<{ objectCount: number; samples: number }>;
}

const baseline = JSON.parse(readFileSync(
  new URL('../../benchmarks/store-baseline.json', import.meta.url), 'utf8',
)) as Baseline;

describe('tracked packed WalObjectStore matrix', () => {
  it('contains the exact scale matrix with separated fixture and transfer evidence', () => {
    expect(baseline.schema).toBe('dkg-wal-packed-object-store-benchmark-v1');
    expect(baseline.executionModel).toBe('fresh-process-per-size');
    expect(baseline.fixturePolicy).toBe('sqlite-index-cardinality-fixture; canonical-verified-admission-and-transfer');
    expect(baseline.sizes).toEqual([10_000, 100_000, 1_000_000, 10_000_000]);
    expect(baseline.repetitions).toBe(1);
    expect(baseline.maximumTimeRegressionRatio).toBe(2);
    expect(baseline.results.map(result => result.objectCount)).toEqual(baseline.sizes);
    expect(baseline.summaries).toEqual(expect.arrayContaining(
      baseline.sizes.map(objectCount => expect.objectContaining({ objectCount, samples: 1 })),
    ));
    for (const result of baseline.results) {
      expect(result.fixtureMode).toBe('sqlite-index-aliases-with-separate-verified-admission');
      expect(result.inventoryPreparationMs).toBeGreaterThan(0);
      expect(result.enumerate).toEqual(expect.objectContaining({ objects: result.objectCount }));
      expect(result.enumerate.totalMs).toBeGreaterThan(0);
      expect(result.hasHit.operations).toBe(10_000);
      expect(result.hasMiss.operations).toBe(10_000);
      expect(result.hasHit.p95Ms).toBeGreaterThan(0);
      expect(result.hasMiss.p95Ms).toBeGreaterThan(0);
      expect(result.fullRead.operations).toBe(1_000);
      expect(result.rangedRead.operations).toBe(1_000);
      expect(result.fullRead.bytes).toBeGreaterThan(result.rangedRead.bytes);
      expect(result.verifiedAdmission.operations).toBe(16);
      expect(result.verifiedAdmission.bytes).toBeGreaterThan(0);
      expect(result.verifiedAdmission.p95Ms).toBeGreaterThan(0);
      expect(result.idempotentAdmission.operations).toBe(16);
      expect(result.idempotentAdmission.p95Ms).toBeGreaterThan(0);
      expect(result.largeObject.payloadBytes).toBe(8 * 1_048_576);
      expect(result.largeObject.canonicalBytes).toBeGreaterThan(result.largeObject.payloadBytes);
      expect(result.largeObject.putMs + result.largeObject.fullReadMs + result.largeObject.rangedReadMs).toBeGreaterThan(0);
      expect(result.rangeReassembly.canonicalBytes).toBe(result.largeObject.canonicalBytes);
      expect(result.rangeReassembly.ranges).toBeGreaterThan(1);
      expect(result.rangeReassembly.totalMs).toBeGreaterThan(0);
      expect(result.totalMs).toBeGreaterThan(result.enumerate.totalMs);
      expect(result.cpu.userMicros + result.cpu.systemMicros).toBeGreaterThan(0);
      expect(result.memory.maxRssBytes).toBeGreaterThan(0);
    }
  });
});
