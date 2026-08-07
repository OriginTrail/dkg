import { describe, expect, it } from 'vitest';
import {
  ReconciliationError,
  compareBytes,
  prepareWalObjectIdInput,
  type WalObjectId
} from '../../src/reconciliation/index.js';
import { deterministicId } from '../support/fixtures.js';

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReconciliationError);
    expect((error as ReconciliationError).code).toBe(code);
  }
}

function consume(input: ReturnType<typeof prepareWalObjectIdInput>): WalObjectId[] {
  return [...input.ids];
}

describe('WalObjectId input preparation', () => {
  const sorted = [deterministicId('input-a'), deterministicId('input-b'), deterministicId('input-c')]
    .sort(compareBytes);

  it('validates a strictly sorted stream without materializing or reordering it', () => {
    function* stream(): IterableIterator<WalObjectId> {
      for (const id of sorted) yield id;
    }

    const prepared = prepareWalObjectIdInput({ ids: stream(), idCount: 3, idsAreSorted: true });
    expect(prepared.idCount).toBe(3);
    expect(consume(prepared)).toEqual(sorted);
    expect(consume(prepareWalObjectIdInput({ ids: [], idCount: 0, idsAreSorted: true }))).toEqual([]);
  });

  it('rejects invalid sorted-stream declarations and contents', () => {
    expectCode(
      () => prepareWalObjectIdInput({ ids: sorted, idsAreSorted: true }),
      'INVALID_CONFIGURATION'
    );
    expectCode(
      () => prepareWalObjectIdInput({ ids: sorted, idCount: -1, idsAreSorted: true }),
      'INVALID_CONFIGURATION'
    );
    expectCode(
      () => prepareWalObjectIdInput({ ids: sorted, idCount: 1.5, idsAreSorted: true }),
      'INVALID_CONFIGURATION'
    );
    expectCode(
      () => consume(prepareWalObjectIdInput({ ids: [new Uint8Array(31) as WalObjectId], idCount: 1, idsAreSorted: true })),
      'INVALID_WAL_OBJECT_ID'
    );
    expectCode(
      () => consume(prepareWalObjectIdInput({ ids: [new Array(32) as never], idCount: 1, idsAreSorted: true })),
      'INVALID_WAL_OBJECT_ID'
    );
    expectCode(
      () => consume(prepareWalObjectIdInput({ ids: [sorted[0], sorted[0]], idCount: 2, idsAreSorted: true })),
      'DUPLICATE_WAL_OBJECT_ID'
    );
    expectCode(
      () => consume(prepareWalObjectIdInput({ ids: [...sorted].reverse(), idCount: 3, idsAreSorted: true })),
      'INVALID_CONFIGURATION'
    );
    expectCode(
      () => consume(prepareWalObjectIdInput({ ids: sorted, idCount: 2, idsAreSorted: true })),
      'COUNT_MISMATCH'
    );
  });

  it('materializes, validates, sorts, and count-checks general iterables', () => {
    const prepared = prepareWalObjectIdInput({ ids: [...sorted].reverse() });
    expect(prepared.idCount).toBe(3);
    expect(consume(prepared)).toEqual(sorted);
    expect(consume(prepareWalObjectIdInput({ ids: sorted, idCount: 3, idsAreSorted: false }))).toEqual(sorted);

    expectCode(
      () => prepareWalObjectIdInput({ ids: [new Uint8Array(31) as WalObjectId] }),
      'INVALID_WAL_OBJECT_ID'
    );
    expectCode(
      () => prepareWalObjectIdInput({ ids: [new Array(32) as never] }),
      'INVALID_WAL_OBJECT_ID'
    );
    expectCode(
      () => prepareWalObjectIdInput({ ids: [sorted[0], sorted[0]] }),
      'DUPLICATE_WAL_OBJECT_ID'
    );
    expectCode(
      () => prepareWalObjectIdInput({ ids: sorted, idCount: -1 }),
      'INVALID_CONFIGURATION'
    );
    expectCode(
      () => prepareWalObjectIdInput({ ids: sorted, idCount: 1.5 }),
      'INVALID_CONFIGURATION'
    );
    expectCode(
      () => prepareWalObjectIdInput({ ids: sorted, idCount: 2 }),
      'COUNT_MISMATCH'
    );
  });
});
