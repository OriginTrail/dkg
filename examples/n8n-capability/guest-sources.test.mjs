import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { guestRevisionHashes } from './test-fixtures/guest-revisions.mjs';
import { normalizeComponentInput } from './component-registry.mjs';
import { normalizeComponentInput as legacyNormalize } from './component-registry-v1.mjs';
import { resolveComponentValue, validateComponentUrl } from './component-values.mjs';
import { programRecords } from './program-block.mjs';
import { studioProgramSource } from './studio-definition.mjs';
import { normalizeBoundEntry } from './studio-entry-input.mjs';
import { normalizeStudioArguments, resolveStudioInputParams, validateComponentValue, studioInputValidationSource } from '../../packages/studio-contracts/dist/studio-inputs.js';
import { canonicalJson } from '../../packages/studio-contracts/dist/canonical-json.js';

test('preserves deployed component, native expression and Studio source bytes and identities', async () => {
  const expected = JSON.parse(readFileSync(new URL('./test-fixtures/guest-revisions.json', import.meta.url)));
  const current = await guestRevisionHashes();
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, current[key]])), expected);
});

test('host function formatting or loader rewrites cannot change persisted guest sources', async () => {
  const expected = await guestRevisionHashes();
  const helpers = [normalizeComponentInput, legacyNormalize, resolveComponentValue, validateComponentUrl, programRecords];
  try {
    for (const helper of helpers) helper.toString = () => 'function transformedHostHelper() { /* loader-specific names */ }';
    assert.deepEqual(await guestRevisionHashes(), expected);
  } finally { for (const helper of helpers) delete helper.toString; }
});

test('named-input guest revisions remain independent of host serialization', () => {
  const snapshots = ['compiler6-file', 'compiler7-data'].map(name =>
    JSON.parse(readFileSync(new URL(`./test-support/${name}-snapshot.json`, import.meta.url))).compiled);
  const sources = () => [studioInputValidationSource('parameters-v1'), studioInputValidationSource('data-v1'), studioInputValidationSource('data-v2'),
    ...snapshots.map(compiled => studioProgramSource(compiled))];
  const expected = sources();
  const helpers = [normalizeStudioArguments, resolveStudioInputParams, validateComponentValue, canonicalJson, normalizeBoundEntry];
  try {
    for (const helper of helpers) helper.toString = () => { throw Error('Host serialization is forbidden'); };
    assert.deepEqual(sources(), expected);
  } finally { for (const helper of helpers) delete helper.toString; }
});
