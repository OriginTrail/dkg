import { describe, it, expect } from 'vitest';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { verifyBatch, buildBatchRejectionRecord } from '../src/swm/verify-batch.js';

const Q = (s: string, p: string, o: string, g = ''): Quad => ({
  subject: s,
  predicate: p,
  object: o,
  graph: g,
});

const sampleQuads: Quad[] = [
  Q('urn:lu8/item1', 'http://schema.org/name', '"Alpha"'),
  Q('urn:lu8/item2', 'http://schema.org/name', '"Beta"'),
  Q('urn:lu8/item3', 'http://schema.org/name', '"Gamma"'),
];

describe('verifyBatch', () => {
  it('returns ok=true when the recomputed root matches the expected root', () => {
    const expected = computeFlatKCRootV10(sampleQuads, []);
    const result = verifyBatch({ quads: sampleQuads, expectedRoot: expected });
    expect(result.ok).toBe(true);
    expect(result.actualRoot).toEqual(result.expectedRoot);
    expect(result.leafCount).toBeGreaterThanOrEqual(1);
    expect(result.reason).toBeUndefined();
  });

  it('returns ok=false with root-mismatch when quads differ from the publisher', () => {
    const expected = computeFlatKCRootV10(sampleQuads, []);
    const tampered = [...sampleQuads, Q('urn:lu8/injected', 'http://schema.org/name', '"Mallory"')];
    const result = verifyBatch({ quads: tampered, expectedRoot: expected });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('root-mismatch');
    expect(result.actualRoot).not.toEqual(result.expectedRoot);
  });

  it('returns ok=false with empty-quads when no plaintext is supplied', () => {
    const expected = computeFlatKCRootV10(sampleQuads, []);
    const result = verifyBatch({ quads: [], expectedRoot: expected });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-quads');
  });

  it('returns ok=false with invalid-expected-root when expectedRoot is not 32 bytes', () => {
    const result = verifyBatch({ quads: sampleQuads, expectedRoot: new Uint8Array(16) });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-expected-root');
  });

  it('is order-independent: shuffled quads produce the same root', () => {
    const expected = computeFlatKCRootV10(sampleQuads, []);
    const shuffled = [sampleQuads[2], sampleQuads[0], sampleQuads[1]];
    const result = verifyBatch({ quads: shuffled, expectedRoot: expected });
    expect(result.ok).toBe(true);
  });

  it('folds in privateRoots when supplied (matching publisher seal)', () => {
    const privateRoot = new Uint8Array(32);
    privateRoot.fill(0xaa);
    const expected = computeFlatKCRootV10(sampleQuads, [privateRoot]);
    const okWithPrivate = verifyBatch({
      quads: sampleQuads,
      privateRoots: [privateRoot],
      expectedRoot: expected,
    });
    expect(okWithPrivate.ok).toBe(true);

    const failWithoutPrivate = verifyBatch({
      quads: sampleQuads,
      expectedRoot: expected,
    });
    expect(failWithoutPrivate.ok).toBe(false);
    expect(failWithoutPrivate.reason).toBe('root-mismatch');
  });
});

describe('buildBatchRejectionRecord', () => {
  const expected = computeFlatKCRootV10(sampleQuads, []);
  const tampered = [...sampleQuads, Q('urn:lu8/injected', 'http://schema.org/name', '"Mallory"')];
  const verifyResult = verifyBatch({ quads: tampered, expectedRoot: expected });

  it('constructs a structured record from a failed verifyResult', () => {
    const record = buildBatchRejectionRecord({
      contextGraphId: 'agent/lu8-curated-1',
      batchId: 'batch-7',
      verifyResult,
      rejectedBy: { agentAddress: '0xMember', peerId: 'memberPeer' },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
    });
    expect(record.contextGraphId).toBe('agent/lu8-curated-1');
    expect(record.batchId).toBe('batch-7');
    expect(record.expectedRoot).toBe(verifyResult.expectedRoot);
    expect(record.actualRoot).toBe(verifyResult.actualRoot);
    expect(record.reason).toBe('root-mismatch');
    expect(record.rejectedBy).toEqual({ agentAddress: '0xMember', peerId: 'memberPeer' });
    expect(record.reportedAt).toBe('2026-05-24T00:00:00.000Z');
    expect(record.digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces stable digests for identical inputs (idempotent dedupe key)', () => {
    const a = buildBatchRejectionRecord({
      contextGraphId: 'agent/lu8',
      verifyResult,
      rejectedBy: { agentAddress: '0xM' },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
    });
    const b = buildBatchRejectionRecord({
      contextGraphId: 'agent/lu8',
      verifyResult,
      rejectedBy: { agentAddress: '0xM' },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
    });
    expect(a.digest).toBe(b.digest);
  });

  it('Codex PR #609: digest is independent of reportedAt (retry-dedupe)', () => {
    // A member that retries the same rejection (transient gossip
    // drop, restart) MUST produce the same digest so the SWM
    // substrate hash-dedupes the record on the consumer side.
    // Including `reportedAt` in the digest would defeat that — the
    // exact regression Codex flagged.
    const earlier = buildBatchRejectionRecord({
      contextGraphId: 'agent/lu8',
      batchId: 'batch-7',
      verifyResult,
      rejectedBy: { agentAddress: '0xM' },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
    });
    const later = buildBatchRejectionRecord({
      contextGraphId: 'agent/lu8',
      batchId: 'batch-7',
      verifyResult,
      rejectedBy: { agentAddress: '0xM' },
      now: () => new Date('2026-05-24T18:42:00.000Z'),
    });
    expect(earlier.digest).toBe(later.digest);
    // `reportedAt` is still preserved as metadata for both records.
    expect(earlier.reportedAt).not.toBe(later.reportedAt);
  });

  it('produces distinct digests when the rejecter or batchId differs', () => {
    const a = buildBatchRejectionRecord({
      contextGraphId: 'agent/lu8',
      batchId: 'batch-a',
      verifyResult,
      rejectedBy: { agentAddress: '0xM' },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
    });
    const b = buildBatchRejectionRecord({
      contextGraphId: 'agent/lu8',
      batchId: 'batch-b',
      verifyResult,
      rejectedBy: { agentAddress: '0xM' },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
    });
    expect(a.digest).not.toBe(b.digest);
  });

  it('throws when called on a successful verifyResult', () => {
    const okResult = verifyBatch({ quads: sampleQuads, expectedRoot: expected });
    expect(() =>
      buildBatchRejectionRecord({
        contextGraphId: 'agent/lu8',
        verifyResult: okResult,
        rejectedBy: { agentAddress: '0xM' },
      }),
    ).toThrow(/ok verify result/);
  });
});
