import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedString,
  closedArray,
  closedRecord,
  identifier,
  nonNegativeInteger,
  plainRecord,
  positiveInteger,
  requireDecoded,
} from './boundary-codec.ts';

test('shared record primitives keep open and closed JSON boundaries distinct', () => {
  assert.deepEqual(plainRecord({ required: 1, future: true }), { required: 1, future: true });
  assert.deepEqual(closedRecord({ required: 1, optional: 2 }, ['required'], ['optional']), {
    required: 1,
    optional: 2,
  });
  assert.equal(closedRecord({ required: 1, future: true }, ['required']), undefined);

  const hidden = { required: 1 };
  Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
  const accessor = {};
  Object.defineProperty(accessor, 'required', { enumerable: true, get: () => 1 });
  const symbol = { required: 1 } as Record<PropertyKey, unknown>;
  symbol[Symbol('hidden')] = true;
  for (const value of [hidden, accessor, symbol, Object.create(null)]) {
    assert.equal(plainRecord(value), undefined);
  }
});

test('shared array, string, identifier, and integer primitives are fail closed', () => {
  assert.equal(closedArray([1, 2], 1, 2), true);
  const sparse = new Array(1);
  const extended: unknown[] & { extra?: boolean } = [1];
  extended.extra = true;
  const accessor = [1];
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => 1 });
  for (const value of [sparse, extended, accessor]) {
    assert.equal(closedArray(value, 0, 2), false);
  }

  assert.equal(boundedString('runtime text', 1, 4_096), 'runtime text');
  assert.equal(identifier('peer:@/id'), 'peer:@/id');
  assert.equal(identifier('contains space'), undefined);
  assert.equal(nonNegativeInteger(0), true);
  assert.equal(nonNegativeInteger(-1), false);
  assert.equal(positiveInteger(1), true);
  assert.equal(positiveInteger(0), false);
});

test('shared throwing adapter preserves its labeled boundary', () => {
  assert.equal(requireDecoded('value', 'test boundary'), 'value');
  assert.throws(() => requireDecoded(undefined, 'test boundary'), /Invalid test boundary/u);
});
