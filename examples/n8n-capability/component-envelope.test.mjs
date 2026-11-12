import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComponentEnvelope } from './component-envelope.mjs';
import { normalizeComponentInput, component } from './component-registry.mjs';

test('envelope validation owns structure and budgets without borrowing component identities', () => {
  const raw = { itemsJson: ' [ {} ] ', paramsJson: ' { "format": "csv" } ' };
  assert.deepEqual(normalizeComponentEnvelope(raw), { itemsJson: '[{}]', paramsJson: '{"format":"csv"}', executionId: '' });
  assert.throws(() => normalizeComponentInput(component('extract-file'), raw), /file/);
  const sheets = { itemsJson: '[{"nested":{"value":1}}]', paramsJson: '{}' };
  assert.doesNotThrow(() => normalizeComponentEnvelope(sheets));
  assert.throws(() => normalizeComponentInput(component('google-sheets'), sheets), /scalar/);
  for (const patch of [{ itemsJson: '{}' }, { itemsJson: '[null]' }, { itemsJson: '[1e400]' },
    { itemsJson: '[{"__nosReserved":1}]' }, { itemsJson: JSON.stringify(Array(21).fill({})) },
    { itemsJson: ' '.repeat(8193) }, { paramsJson: '[]' }, { paramsJson: '{"a":1e400}' },
    { paramsJson: '{"constructor":1}' }, { paramsJson: ' '.repeat(2049) },
    { executionId: 'invalid' }, { extra: true }])
    assert.throws(() => normalizeComponentEnvelope({ ...raw, ...patch }));
});
