import { describe, expect, it } from 'vitest';
import { ReceiptBatcher } from '../src/index.js';
import type { ReceiptClaimInput } from '../src/index.js';

function claim(overrides: Partial<ReceiptClaimInput> = {}): ReceiptClaimInput {
  return {
    buyer: '0x2222222222222222222222222222222222222222',
    epoch: 42n,
    offeringId: '0x' + '11'.repeat(32),
    callId: '0x' + 'aa'.repeat(32),
    maxUnits: 1000n,
    askPerUnitWei: 500_000_000_000n,
    expiry: 1_793_577_600n,
    servedUnits: 100n,
    resultCommitment: '0x' + 'bb'.repeat(32),
    authSignature: '0x' + 'cc'.repeat(65),
    ...overrides,
  };
}

function batcherWith(overrides: Partial<ConstructorParameters<typeof ReceiptBatcher>[0]> = {}) {
  let nowMs = 0;
  const batcher = new ReceiptBatcher(
    { maxBatchSize: 3, maxDelayMs: 60_000, maxBuyerExposureWei: 10n ** 18n, ...overrides },
    () => nowMs,
  );
  return { batcher, advance: (ms: number) => { nowMs += ms; } };
}

describe('ReceiptBatcher', () => {
  it('submits when a batch reaches maxBatchSize, in chunks, oldest first', () => {
    const { batcher } = batcherWith();
    for (let index = 0; index < 7; index++) batcher.add(claim({ callId: `0x${String(index).padStart(64, '0')}` }));
    const batches = batcher.collectDue();
    expect(batches.map((batch) => [batch.trigger, batch.claims.length])).toEqual([
      ['size', 3],
      ['size', 3],
    ]);
    expect(batches[0].claims[0].callId).toBe(`0x${'0'.padStart(64, '0')}`);
    expect(batcher.pendingCount()).toBe(1); // the trailing claim waits for delay/exposure
  });

  it('submits a partial batch once the oldest claim has waited maxDelayMs', () => {
    const { batcher, advance } = batcherWith();
    batcher.add(claim());
    advance(59_999);
    expect(batcher.collectDue()).toEqual([]);
    advance(1);
    const batches = batcher.collectDue();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ epoch: 42n, trigger: 'delay' });
    expect(batcher.pendingCount()).toBe(0);
  });

  it('submits immediately when one buyer bucket exposure crosses the threshold', () => {
    const { batcher } = batcherWith({ maxBatchSize: 10, maxBuyerExposureWei: 100_000_000_000_000n });
    // 100 units * 5e11 = 5e13 per claim; one claim stays under the 1e14 threshold.
    batcher.add(claim({ callId: '0x' + '01'.repeat(32) }));
    expect(batcher.collectDue()).toEqual([]);
    // A second claim from a DIFFERENT buyer does not pool exposure.
    batcher.add(claim({ callId: '0x' + '02'.repeat(32), buyer: '0x3333333333333333333333333333333333333333' }));
    expect(batcher.collectDue()).toEqual([]);
    // The same buyer reaching EXACTLY the threshold is still fine (strict >).
    batcher.add(claim({ callId: '0x' + '03'.repeat(32) }));
    expect(batcher.collectDue()).toEqual([]);
    // One more claim pushes that buyer past 1e14 -> submit now.
    batcher.add(claim({ callId: '0x' + '04'.repeat(32) }));
    const batches = batcher.collectDue();
    expect(batches).toHaveLength(1);
    expect(batches[0].trigger).toBe('exposure');
    expect(batches[0].claims).toHaveLength(4);
    expect(batcher.pendingCount()).toBe(0);
  });

  it('tracks exposure per (buyer, epoch) bucket', () => {
    const { batcher } = batcherWith();
    batcher.add(claim({ callId: '0x' + '01'.repeat(32) }));
    batcher.add(claim({ callId: '0x' + '02'.repeat(32), epoch: 43n }));
    batcher.add(claim({ callId: '0x' + '03'.repeat(32), buyer: '0x3333333333333333333333333333333333333333' }));
    expect(batcher.pendingExposureWei('0x2222222222222222222222222222222222222222', 42n)).toBe(50_000_000_000_000n);
    expect(batcher.pendingExposureWei('0x2222222222222222222222222222222222222222', 43n)).toBe(50_000_000_000_000n);
    expect(batcher.pendingExposureWei('0x3333333333333333333333333333333333333333', 42n)).toBe(50_000_000_000_000n);
    expect(batcher.pendingExposureWei('0x4444444444444444444444444444444444444444', 42n)).toBe(0n);
  });

  it('keeps epochs in separate batches', () => {
    const { batcher, advance } = batcherWith();
    batcher.add(claim({ epoch: 42n }));
    batcher.add(claim({ epoch: 43n, callId: '0x' + '02'.repeat(32) }));
    advance(60_000);
    const batches = batcher.collectDue();
    expect(batches.map((batch) => batch.epoch)).toEqual([42n, 43n]);
  });

  it('drainAll flushes everything regardless of triggers', () => {
    const { batcher } = batcherWith();
    batcher.add(claim({ epoch: 42n }));
    batcher.add(claim({ epoch: 43n, callId: '0x' + '02'.repeat(32) }));
    const batches = batcher.drainAll();
    expect(batches.map((batch) => [batch.epoch, batch.trigger])).toEqual([
      [42n, 'flush'],
      [43n, 'flush'],
    ]);
    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.drainAll()).toEqual([]);
  });

  it('validates its policy', () => {
    expect(() => new ReceiptBatcher({ maxBatchSize: 0, maxDelayMs: 1, maxBuyerExposureWei: 0n })).toThrow(
      'maxBatchSize',
    );
    expect(() => new ReceiptBatcher({ maxBatchSize: 1, maxDelayMs: -1, maxBuyerExposureWei: 0n })).toThrow(
      'maxDelayMs',
    );
    expect(() => new ReceiptBatcher({ maxBatchSize: 1, maxDelayMs: 1, maxBuyerExposureWei: -1n })).toThrow(
      'maxBuyerExposureWei',
    );
  });
});
