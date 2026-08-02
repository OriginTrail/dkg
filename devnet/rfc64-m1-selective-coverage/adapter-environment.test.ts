import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSelectiveCoverageAdapterEnvironment } from './adapter-environment.ts';

test('strips immutable operator inputs from the spawned adapter environment', () => {
  const parent = {
    NODE_ENV: 'development',
    DKG_RFC64_M1_CORPUS_FILE: '/secure/corpus.json',
    DKG_RFC64_M1_TRUST_ANCHOR_FILE: '/secure/trust-anchor.json',
    DKG_RFC64_M1_ARTIFACT: '/secure/pass-artifact.json',
    PRESERVED_ADAPTER_SETTING: 'present',
  };
  const result = buildSelectiveCoverageAdapterEnvironment(parent);

  assert.equal(result.NODE_ENV, 'production');
  assert.equal(result.PRESERVED_ADAPTER_SETTING, 'present');
  assert.equal(Object.hasOwn(result, 'DKG_RFC64_M1_CORPUS_FILE'), false);
  assert.equal(Object.hasOwn(result, 'DKG_RFC64_M1_TRUST_ANCHOR_FILE'), false);
  assert.equal(Object.hasOwn(result, 'DKG_RFC64_M1_ARTIFACT'), false);
  assert.equal(parent.DKG_RFC64_M1_TRUST_ANCHOR_FILE, '/secure/trust-anchor.json');
});
