import { describe, expect, it } from 'vitest';
import { StoredSwmRowsCacheV1 } from '../src/rfc64/inventory-v1/swm-author-inventory-stored-rows.js';

const key = { scope: Buffer.alloc(32, 1), author: Buffer.alloc(20, 2) };
const u64 = Buffer.from('0000000000000001', 'hex');
function stored(number: number, padding = '') {
  const ual = 'did:dkg:otp:20430/0x' + '11'.repeat(20) + '/' + number;
  const coordinate = 'a' + number + padding;
  const operation = 's' + number + padding;
  return {
    ka_ual: ual,
    assertion_coordinate: coordinate,
    exact_text: Buffer.from('\uFEFF' + [ual, coordinate, operation].join('\0')),
    assertion_version_u64be: u64,
    share_operation_id: operation,
    projection_digest: Buffer.alloc(32, 1),
    public_triple_count_u64be: u64,
    private_triple_count_u64be: u64,
    seal_digest: Buffer.alloc(32, 2),
    shared_at_u64be: u64,
    expires_at_u64be: null,
  };
}

function reader() {
  const cache = new StoredSwmRowsCacheV1();
  return (scope: typeof key, values: ReturnType<typeof stored>[]) => {
    const result = cache.decode(scope, values);
    cache.remember(scope, result.cache);
    return result;
  };
}

describe('verified SQL row reuse', () => {
  it('uses private witnesses and still rejects duplicate rows after SQL order changes', () => {
    const read = reader(), first = stored(1), second = stored(2);
    const initial = read(key, [second, first]);
    const reread = read(key, [first, second]);
    expect(reread.rows).toEqual(initial.rows);
    expect(reread.rows[0]).toBe(initial.rows[0]);
    expect(read(key, [first, second]).rows).toBe(reread.rows);
    first.projection_digest.fill(3);
    const changed = read(key, [first, second]);
    expect(changed.rows[0]).not.toBe(reread.rows[0]);
    expect(changed.rows[1]).toBe(reread.rows[1]);
    expect(() => read(key, [second, second])).toThrow();
  });

  it('retains two scope/author pairs and evicts the least recently read on a third', () => {
    const read = reader(), values = [stored(1)];
    const otherScope = { ...key, scope: Buffer.alloc(32, 3) };
    const otherAuthor = { ...key, author: Buffer.alloc(20, 4) };
    const first = read(key, values).rows;
    const second = read(otherScope, values).rows;
    expect(second[0]).not.toBe(first[0]);
    expect(read(key, values).rows).toBe(first); // Refresh the first scope.
    read(otherAuthor, values);
    expect(read(key, values).rows).toBe(first);
    expect(read(otherScope, values).rows[0]).not.toBe(second[0]);
  });

  it.each([
    { count: 8_300, padding: '', limit: 'row count' },
    { count: 5_000, padding: 'x'.repeat(190), limit: 'field bytes' },
  ])('enforces one aggregate $limit budget across the two slots', ({ count, padding }) => {
    const read = reader();
    const values = Array.from({ length: count }, (_, index) => stored(index + 1, padding));
    const first = read(key, values);
    const other = { ...key, scope: Buffer.alloc(32, 3) };
    const second = read(other, values);
    expect(first.cache).toBeDefined();
    expect(second.cache).toBeDefined();
    expect(read(other, values).rows).toBe(second.rows);
    expect(read(key, values).rows[0]).not.toBe(first.rows[0]);
  }, 30_000);

  it.each([
    { count: 16_385, padding: '', limit: 'row count' },
    { count: 9_000, padding: 'x'.repeat(190), limit: 'field bytes' },
  ])('still validates and serves a legal inventory beyond the $limit cache limit', ({ count, padding }) => {
    const read = reader();
    const values = Array.from({ length: count }, (_, index) => stored(index + 1, padding));
    const result = read(key, values);
    expect(result.rows).toHaveLength(count);
    expect(result.cache).toBeUndefined();
    const last = values[count - 1]!;
    last.projection_digest = Buffer.alloc(31);
    expect(() => read(key, values)).toThrow();
  }, 30_000);
});
