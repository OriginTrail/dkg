import { describe, expect, it } from 'vitest';

import {
  buildBoundedSystemRecordUtf8V1,
  isSystemRecordBoundedBuildOverflowV1,
  SYSTEM_RECORD_BOUNDED_BUILD_OVERFLOW_V1,
} from '../src/system-record-bounded-utf8-builder-v1-internal.js';
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

  it('fails the retained-byte bound before allocation or charging', () => {
    const charges: number[] = [];
    expect(() => buildBoundedSystemRecordUtf8V1({
      emit: (writer) => writer.add('abcd'),
      maxEncodedBytes: 4,
      maxRetainedBytes: 11,
      label: 'test payload',
      replaceCharge: (bytes) => charges.push(bytes),
    })).toThrow(/retained-byte bound/);
    expect(charges).toEqual([]);
  });

  // Identity at the SOURCE, in BOTH polarities.
  //
  // The cases above assert by MESSAGE, which cannot tell a tagged refusal from an untagged
  // one: drop the code and every one of them still passes. The only consumer — the legacy
  // agent-profile gate read, which turns an over-bound REQUEST into a truncated answer
  // rather than a thrown page — discriminates on the code, so an untagged refusal there
  // silently reverts to rethrowing.
  //
  // The negative half carries equal weight. An accounting mismatch is a broken internal
  // invariant, not a caller asking for more than the bound allows; translating it into a
  // bounded answer would hide a defect behind a normal-looking result. Nothing pinned that
  // separation, so the two throws could have converged on one code without a failure.
  //
  // SCOPE OF THE NEGATIVE HALF, stated because a mutant proved the looser reading wrong:
  // it covers the WRITE-PHASE accounting guard, which is the only one of the four a caller
  // can drive from `emit`. Tagging any of the other three still passes this case — they
  // are reachable only if the builder's own two-pass accounting is already broken, so no
  // fixture short of editing the builder reaches them.
  it('tags both bound refusals with the canonical code, and the drift error with none', () => {
    const thrown = (run: () => unknown): unknown => {
      try { run(); return null; } catch (error) { return error; }
    };

    const encodedOverflow = thrown(() => buildBoundedSystemRecordUtf8V1({
      emit: (writer) => writer.add('abcd'),
      maxEncodedBytes: 3,
      maxRetainedBytes: 9,
      label: 'test payload',
    }));
    expect(isSystemRecordBoundedBuildOverflowV1(encodedOverflow)).toBe(true);
    expect((encodedOverflow as { code?: unknown }).code)
      .toBe(SYSTEM_RECORD_BOUNDED_BUILD_OVERFLOW_V1);

    const retainedOverflow = thrown(() => buildBoundedSystemRecordUtf8V1({
      emit: (writer) => writer.add('abcd'),
      maxEncodedBytes: 4,
      maxRetainedBytes: 11,
      label: 'test payload',
    }));
    expect(isSystemRecordBoundedBuildOverflowV1(retainedOverflow)).toBe(true);

    let pass = 0;
    const drift = thrown(() => buildBoundedSystemRecordUtf8V1({
      emit: (writer) => writer.add(pass++ === 0 ? 'a' : 'bb'),
      maxEncodedBytes: 2,
      maxRetainedBytes: 6,
      label: 'test payload',
    }));
    // Asserted to BE an error first: a run that threw nothing would satisfy the negative
    // assertion below just as well, and prove nothing.
    expect(drift).toBeInstanceOf(Error);
    expect(isSystemRecordBoundedBuildOverflowV1(drift)).toBe(false);
  });
});
