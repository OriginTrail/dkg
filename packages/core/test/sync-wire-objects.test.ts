import { describe, expect, it } from 'vitest';

import { assertExactKeys, isPlainRecord } from '../src/sync-wire-objects.js';

describe('RFC-64 sync wire object helpers', () => {
  it('accepts ordinary and null-prototype records', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.value = 'ok';

    expect(isPlainRecord({ value: 'ok' })).toBe(true);
    expect(isPlainRecord(nullPrototype)).toBe(true);
    expect(() => assertExactKeys(nullPrototype, ['value'], 'fixture')).not.toThrow();
  });

  it('rejects null, arrays, and class instances as non-plain records', () => {
    class Fixture {
      value = 'ok';
    }

    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(new Fixture())).toBe(false);
  });

  it('rejects unknown, missing, and symbol keys', () => {
    expect(() => assertExactKeys({ value: 'ok', extra: true }, ['value'], 'fixture')).toThrow(
      /unknown or missing fields/,
    );
    expect(() => assertExactKeys({}, ['value'], 'fixture')).toThrow(
      /unknown or missing fields/,
    );

    const symbolRecord = { value: 'ok' } as Record<PropertyKey, unknown>;
    symbolRecord[Symbol('hidden')] = true;
    expect(() => assertExactKeys(symbolRecord, ['value'], 'fixture')).toThrow(
      /symbol properties/,
    );
  });

  it('rejects non-enumerable and accessor property descriptors', () => {
    const nonEnumerable = {} as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'value', {
      enumerable: false,
      value: 'ok',
    });
    expect(() => assertExactKeys(nonEnumerable, ['value'], 'fixture')).toThrow(
      /enumerable data properties/,
    );

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => 'ok',
    });
    expect(() => assertExactKeys(accessor, ['value'], 'fixture')).toThrow(
      /enumerable data properties/,
    );
  });

  it('keeps the closed-data helpers internal to core', async () => {
    const root = await import('../src/index.js') as Record<string, unknown>;
    expect(root).not.toHaveProperty('snapshotExactDataRecord');
    expect(root).not.toHaveProperty('isPlainRecord');
  });
});
