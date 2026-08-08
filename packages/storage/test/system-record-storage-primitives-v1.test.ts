import { describe, expect, it } from 'vitest';

import { buildBoundedSystemRecordUtf8V1 } from '../src/system-record-bounded-utf8-builder-v1-internal.js';
import {
  snapshotSystemRecordDenseArrayV1,
  snapshotSystemRecordExactDataRecordV1,
} from '../src/system-record-input-guards-v1-internal.js';

describe('system-record storage trust-boundary primitives', () => {
  it('snapshots exact closed data without invoking accessors or proxy traps', () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => { invoked = true; return 'x'; },
    });
    expect(() => snapshotSystemRecordExactDataRecordV1(
      accessor,
      ['value'],
      'record',
    )).toThrow(/data properties/);
    expect(invoked).toBe(false);

    const proxied = new Proxy({ value: 'x' }, {
      ownKeys: () => { invoked = true; return ['value']; },
    });
    expect(() => snapshotSystemRecordExactDataRecordV1(
      proxied,
      ['value'],
      'record',
    )).toThrow(/must not be a Proxy/);
    expect(invoked).toBe(false);
  });

  it('copies and freezes only bounded closed dense array elements', () => {
    const source = ['a', 'b'];
    const snapshot = snapshotSystemRecordDenseArrayV1(source, {
      label: 'rows',
      minLength: 2,
      maxLength: 2,
    });
    source[0] = 'changed';
    expect(snapshot).toEqual(['a', 'b']);
    expect(Object.isFrozen(snapshot)).toBe(true);

    const decorated = ['a'];
    Object.defineProperty(decorated, 'extra', { enumerable: true, value: 'x' });
    expect(() => snapshotSystemRecordDenseArrayV1(decorated, {
      label: 'rows',
      maxLength: 2,
    })).toThrow(/dense closed array/);
  });

  it('builds one exact UTF-8 buffer with explicit peak and retained charges', () => {
    const charges: number[] = [];
    const result = buildBoundedSystemRecordUtf8V1({
      emit: (writer) => {
        writer.add('alpha');
        writer.add('\u20ac');
      },
      maxEncodedBytes: 8,
      maxRetainedBytes: 24,
      label: 'test payload',
      replaceCharge: (bytes) => charges.push(bytes),
    });
    expect(result).toEqual({ value: 'alpha\u20ac', encodedBytes: 8 });
    expect(charges).toEqual([24, 16]);
  });

  it('fails before allocation on byte overflow and detects two-pass drift', () => {
    expect(() => buildBoundedSystemRecordUtf8V1({
      emit: (writer) => writer.add('abcd'),
      maxEncodedBytes: 3,
      maxRetainedBytes: 9,
      label: 'test payload',
    })).toThrow(/exceeds/);

    let pass = 0;
    expect(() => buildBoundedSystemRecordUtf8V1({
      emit: (writer) => writer.add(pass++ === 0 ? 'a' : 'bb'),
      maxEncodedBytes: 2,
      maxRetainedBytes: 6,
      label: 'test payload',
    })).toThrow(/accounting mismatch/);
  });
});
