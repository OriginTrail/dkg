import { describe, expect, it } from 'vitest';
import * as codec from '../src/swm-author-inventory-v1.js';
import type { SwmAuthorInventoryRowV1 } from '../src/swm-author-inventory-v1.js';

function row(n = 1): SwmAuthorInventoryRowV1 {
  return {
    assertionCoordinate: `draft-${n}`, assertionVersion: '1',
    kaUal: `did:dkg:otp:20430/0x3333333333333333333333333333333333333333/${n}`,
    shareOperationId: `share-${n}`, projectionDigest: `0x${'11'.repeat(32)}`,
    publicTripleCount: '1', privateTripleCount: '0', sealDigest: `0x${'22'.repeat(32)}`,
    sharedAt: '1700000000000', expiresAt: null,
  } as SwmAuthorInventoryRowV1;
}

describe('owned SWM inventory snapshots', () => {
  it('preserves canonical bytes and digest without wire roundtrips', () => {
    const input = [row(1), row(2)];
    const expected = codec.canonicalizeSwmAuthorInventoryRowsBytesV1(input);
    const snapshot = codec.snapshotSwmAuthorInventoryRowsV1(input);
    expect(codec.canonicalizeSwmAuthorInventoryRowsBytesV1(snapshot)).toEqual(expected);
    expect(codec.computeSwmAuthorInventoryRowsDigestV1(snapshot))
      .toBe(codec.computeSwmAuthorInventoryRowsDigestV1(input));
    expect(codec.snapshotSwmAuthorInventoryRowsV1(snapshot)).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it('does not trust frozen caller arrays, mutable rows, or exposed bytes', () => {
    const original = row();
    const input = Object.freeze([original]);
    const snapshot = codec.snapshotSwmAuthorInventoryRowsV1(input);
    const digest = codec.computeSwmAuthorInventoryRowsDigestV1(snapshot);
    Object.assign(original, { shareOperationId: 'changed' });
    codec.canonicalizeSwmAuthorInventoryRowsBytesV1(snapshot).fill(0);
    expect(snapshot[0]!.shareOperationId).toBe('share-1');
    expect(codec.computeSwmAuthorInventoryRowsDigestV1(snapshot)).toBe(digest);
    expect(codec.snapshotSwmAuthorInventoryRowsV1(input)[0]!.shareOperationId).toBe('changed');
  });

  it('reuses only owned row identities across successor snapshots', () => {
    const original = Object.freeze(row());
    const owned = codec.snapshotSwmAuthorInventoryRowV1(original);
    expect(owned).not.toBe(original);
    expect(codec.snapshotSwmAuthorInventoryRowV1(owned)).toBe(owned);
    const successor = codec.snapshotSwmAuthorInventoryRowsV1([owned, row(2)]);
    expect(successor[0]).toBe(owned);
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1([owned, owned])).toThrow();
  });

  it('rejects accessors without evaluating them and rejects adorned arrays', () => {
    let reads = 0;
    const accessor = Object.freeze({ ...row(), get shareOperationId() { reads++; return 'share'; } });
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1([accessor])).toThrow();
    expect(reads).toBe(0);
    const accessorArray = Object.defineProperty([row()], '0', { get() { reads++; return row(); } });
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1(accessorArray)).toThrow();
    expect(reads).toBe(0);
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1(Object.assign([row()], { extra: 1 }))).toThrow();
    const owned = codec.snapshotSwmAuthorInventoryRowV1(row());
    expect(() => codec.canonicalizeSwmAuthorInventoryRowsBytesV1(Object.assign([owned], { extra: 1 }))).toThrow();
  });

  it('retains scalar, Unicode, order, uniqueness and count limits', () => {
    for (const change of [{ assertionVersion: '01' }, { shareOperationId: '\ud800' },
      { expiresAt: '1' }, { extra: 'field' }]) {
      expect(() => codec.snapshotSwmAuthorInventoryRowsV1([{ ...row(), ...change }])).toThrow();
    }
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1([row(2), row(1)])).toThrow();
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1([row(1), { ...row(2), shareOperationId: 'share-1' }])).toThrow();
    let inspections = 0;
    const oversized = new Proxy(Array.from({ length: codec.MAX_SWM_AUTHOR_INVENTORY_ROWS_V1 + 1 }), {
      ownKeys() { inspections++; throw new Error('oversized entries inspected'); },
    });
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1(oversized)).toThrowError(
      expect.objectContaining({
        code: 'swm-inventory-too-large',
        message: '[swm-inventory-too-large] row set exceeds the v1 row limit',
      }),
    );
    expect(inspections).toBe(0);
  });

  it('enforces the full byte bound when composing owned row encodings', () => {
    const rows = Array.from({ length: 25000 }, (_, index) => row(index + 1));
    expect(() => codec.snapshotSwmAuthorInventoryRowsV1(rows)).toThrowError(
      expect.objectContaining({ code: 'swm-inventory-too-large' }),
    );
  });

  it('does not turn caller proxies into trusted identities', () => {
    const { proxy, revoke } = Proxy.revocable(Object.freeze(row()), {});
    const snapshot = codec.snapshotSwmAuthorInventoryRowV1(proxy);
    revoke();
    expect(snapshot.kaUal).toBe(row().kaUal);
    expect(() => codec.snapshotSwmAuthorInventoryRowV1(proxy)).toThrow();
  });
});
