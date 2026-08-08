import { describe, expect, it } from 'vitest';

import { compareSystemRecordUtf8V1 } from '../src/system-record-utf8-order-v1-internal.js';

describe('system-record canonical UTF-8 ordering', () => {
  it('matches encoded byte ordering without comparator allocations', () => {
    const values = [
      '', 'a', 'aa', 'z', '\u007f', '\u0080', '\u07ff', '\u0800',
      '\ud7ff', '\ue000', '\uffff', '\ud800\udc00', '\udbff\udfff',
    ];
    const expected = [...values].sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    expect([...values].sort(compareSystemRecordUtf8V1)).toEqual(expected);
  });
});
