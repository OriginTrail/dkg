import { describe, expect, it } from 'vitest';
import {
  MutableSetCommitment,
  ReconciliationError,
  bytesToHex,
  createFallbackPages,
  packNibblePrefix,
  reconciliationHead,
  setCommitment,
  setCommitmentRoot,
  verifyFallbackPages,
  walObjectId
} from '../../src/reconciliation/index.js';
import {
  deterministicHead,
  deterministicHeadId,
  deterministicId,
  deterministicSet
} from '../support/fixtures.js';

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.fail('operation unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(ReconciliationError);
    expect((error as ReconciliationError).code).toBe(code);
  }
}

describe('16-way radix set commitment', () => {
  it('is deterministic, insertion-order independent, and change-sensitive', () => {
    const ids = deterministicSet('commitment', 300);
    const root = setCommitment(ids);
    expect(bytesToHex(root)).toHaveLength(64);
    expect(setCommitment([...ids].reverse())).toEqual(root);
    expect(setCommitment([...ids, deterministicId('extra')])).not.toEqual(root);
    expect(setCommitment([])).toEqual(setCommitment([]));
    expectCode(() => setCommitment([ids[0], ids[0]]), 'DUPLICATE_WAL_OBJECT_ID');
    expectCode(() => setCommitment([new Uint8Array(31) as never]), 'INVALID_WAL_OBJECT_ID');
  });

  it('packs odd prefixes into the high nibble and rejects invalid prefixes', () => {
    expect(packNibblePrefix([0xa, 0xb, 0xc])).toEqual(Uint8Array.of(0xab, 0xc0));
    expect(packNibblePrefix([])).toEqual(new Uint8Array());
    expect(() => packNibblePrefix([16])).toThrow('invalid nibble');
    expect(() => packNibblePrefix([-1])).toThrow('invalid nibble');
    expect(() => packNibblePrefix([1.5])).toThrow('invalid nibble');
    expect(() => packNibblePrefix(Array.from({ length: 65 }, () => 0))).toThrow('too long');
  });

  it('splits at odd and even nibble depths with sparse child bitmaps', () => {
    const ids = deterministicSet('deep-commitment', 300).map((id) => {
      const forced = new Uint8Array(id);
      forced[0] = 0xa0 | (forced[0] & 0x0f);
      return walObjectId(forced);
    });
    expect(bytesToHex(setCommitment(ids))).toHaveLength(64);
    expect(setCommitment([...ids].reverse())).toEqual(setCommitment(ids));
  });

  it('incrementally inserts, deletes, collapses, serializes, and restores', () => {
    const ids = deterministicSet('mutable', 300);
    const mutable = new MutableSetCommitment(ids);
    expect(mutable.size).toBe(300);
    expect(mutable.root).toEqual(setCommitment(ids));
    expect(mutable.ids()).toEqual([...ids].sort((left, right) => bytesToHex(left).localeCompare(bytesToHex(right))));

    const extra = deterministicId('mutable-extra');
    expect(mutable.has(extra)).toBe(false);
    expect(mutable.insert(extra)).toEqual(setCommitment([...ids, extra]));
    expect(mutable.has(extra)).toBe(true);
    expectCode(() => mutable.insert(extra), 'DUPLICATE_WAL_OBJECT_ID');
    expect(mutable.delete(deterministicId('absent'))).toBe(false);
    expect(mutable.delete(extra)).toBe(true);
    expect(mutable.root).toEqual(setCommitment(ids));

    for (const id of ids.slice(0, 44)) expect(mutable.delete(id)).toBe(true);
    expect(mutable.size).toBe(256);
    expect(mutable.root).toEqual(setCommitment(ids.slice(44)));
    const snapshot = mutable.serialize();
    const restored = MutableSetCommitment.restore(snapshot);
    expect(restored.root).toEqual(mutable.root);
    expect(restored.ids()).toEqual(mutable.ids());

    for (const id of restored.ids()) expect(restored.delete(id)).toBe(true);
    expect(restored.size).toBe(0);
    expect(restored.root).toEqual(setCommitment([]));
    expect(restored.delete(ids[0])).toBe(false);
  });

  it('covers empty and sparse-branch incremental paths', () => {
    const empty = new MutableSetCommitment();
    expect(empty.has(deterministicId('empty-absent'))).toBe(false);
    expect(empty.ids()).toEqual([]);
    const first = deterministicId('empty-first');
    empty.insert(first);
    expect(empty.root).toEqual(setCommitment([first]));

    const concentrated = deterministicSet('concentrated', 256).map((id) => {
      const copy = new Uint8Array(id);
      copy[0] &= 0x0f;
      return walObjectId(copy);
    });
    const sparse = new MutableSetCommitment();
    for (const id of concentrated) sparse.insert(id);
    const splitTriggerBytes = new Uint8Array(deterministicId('split-trigger'));
    splitTriggerBytes[0] &= 0x0f;
    const splitTrigger = walObjectId(splitTriggerBytes);
    sparse.insert(splitTrigger);
    expect(sparse.root).toEqual(setCommitment([...concentrated, splitTrigger]));

    const missingBranchBytes = new Uint8Array(deterministicId('missing-branch'));
    missingBranchBytes[0] = 0xf0 | (missingBranchBytes[0] & 0x0f);
    const missingBranch = walObjectId(missingBranchBytes);
    expect(sparse.has(missingBranch)).toBe(false);
    expect(sparse.delete(missingBranch)).toBe(false);
    sparse.insert(missingBranch);
    expect(sparse.has(missingBranch)).toBe(true);
    expect(sparse.ids()).toHaveLength(258);
    expect(sparse.root).toEqual(setCommitment([...concentrated, splitTrigger, missingBranch]));
  });

  it('rejects malformed commitment snapshots', () => {
    expectCode(() => MutableSetCommitment.restore(new Uint8Array()), 'INVALID_BYTES');
    const valid = new MutableSetCommitment([deterministicId('snapshot')]).serialize();
    const badMagic = new Uint8Array(valid);
    badMagic[0] ^= 1;
    expectCode(() => MutableSetCommitment.restore(badMagic), 'INVALID_BYTES');
    expectCode(() => MutableSetCommitment.restore(valid.slice(0, -1)), 'INVALID_BYTES');
    const hugeCount = new Uint8Array(16);
    hugeCount.set(new TextEncoder().encode('DKGWSET1'));
    new DataView(hugeCount.buffer).setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 1n, false);
    expectCode(() => MutableSetCommitment.restore(hugeCount), 'INTEGER_OUT_OF_RANGE');
  });
});

describe('head-bound sorted paginated fallback', () => {
  it('round-trips exact sorted IDs and verifies count and root', () => {
    const ids = deterministicSet('fallback', 7).reverse();
    const head = deterministicHead('fallback-head', ids);
    const pages = createFallbackPages(ids, head, 3);
    const verified = verifyFallbackPages(pages, head);
    expect(verified).toHaveLength(7);
    expect(pages.map((page) => page.offset)).toEqual([0, 3, 6]);
    expect(pages.map((page) => page.done)).toEqual([false, false, true]);
    expect(pages.every((page) => bytesToHex(page.headId) === bytesToHex(head.headId))).toBe(true);

    const emptyHead = deterministicHead('empty-head', []);
    expect(createFallbackPages([], emptyHead, 3)).toEqual([
      { headId: emptyHead.headId, offset: 0, ids: [], done: true }
    ]);
    expectCode(() => verifyFallbackPages([], emptyHead), 'FALLBACK_DONE_MISMATCH');
    expectCode(() => createFallbackPages(ids, head, 0), 'INVALID_CONFIGURATION');
    expectCode(
      () => reconciliationHead(head.headId, -1, head.objectSetRoot),
      'INVALID_CONFIGURATION'
    );
  });

  it('rejects head, page, count, ordering, and root corruption', () => {
    const ids = deterministicSet('fallback-corrupt', 4);
    const head = deterministicHead('fallback-corrupt-head', ids);
    const pages = createFallbackPages(ids, head, 2);
    expectCode(
      () => verifyFallbackPages([{ ...pages[0], headId: deterministicHeadId('wrong') }, pages[1]], head),
      'FALLBACK_HEAD_MISMATCH'
    );
    expectCode(() => verifyFallbackPages([{ ...pages[0], offset: 1 }, pages[1]], head), 'FALLBACK_OFFSET_MISMATCH');
    expectCode(() => verifyFallbackPages([{ ...pages[0], done: true }, pages[1]], head), 'FALLBACK_DONE_MISMATCH');
    const wrongCount = reconciliationHead(head.headId, 5, head.objectSetRoot);
    expectCode(() => verifyFallbackPages(pages, wrongCount), 'COUNT_MISMATCH');
    const unordered = createFallbackPages(ids, head, 4);
    [unordered[0].ids[0], unordered[0].ids[1]] = [unordered[0].ids[1], unordered[0].ids[0]];
    expectCode(() => verifyFallbackPages(unordered, head), 'FALLBACK_ORDER_MISMATCH');
    const duplicated = createFallbackPages(ids, head, 4);
    duplicated[0].ids[1] = duplicated[0].ids[0];
    expectCode(() => verifyFallbackPages(duplicated, head), 'FALLBACK_ORDER_MISMATCH');
    const omitted = [{ ...pages[0], done: true }];
    expectCode(() => verifyFallbackPages(omitted, head), 'COUNT_MISMATCH');
    const extra = createFallbackPages(ids, head, 4);
    extra[0].ids.push(deterministicId('fallback-extra'));
    expectCode(() => verifyFallbackPages(extra, head), 'COUNT_MISMATCH');
    const wrongRoot = reconciliationHead(head.headId, 4, setCommitmentRoot(deterministicId('wrong-root')));
    expectCode(() => verifyFallbackPages(pages, wrongRoot), 'ROOT_MISMATCH');
  });
});
