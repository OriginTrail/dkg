/** Guard lifecycle coverage across the primary and required EVM CI lanes. */
import { describe, it, expect } from 'vitest';
import { EVM_TEST_SCOPES } from '../../../scripts/ci/evm-test-scopes.mjs';
import primary from '../vitest.config';
import integration from '../../../vitest.evm-integration';

describe('chain lifecycle test ownership [CH-1]', () => {
  it('keeps broad primary discovery and explicit integration ownership', () => {
    expect(primary.test?.include).toContain('test/**/*.test.ts');
    expect(integration.test?.include).toEqual([...EVM_TEST_SCOPES.chain.files]);
  });

  it('assigns the adapter lifecycle to the dedicated real-EVM runner', () => {
    for (const file of EVM_TEST_SCOPES.chain.files) expect(primary.test?.exclude).toContain(file);
    expect(integration.test?.exclude ?? []).toEqual([]);
  });

  it('excludes archives without dropping other active lifecycle files', () => {
    expect(primary.test?.exclude).toContain('test/archive/**');
    const excludedTestFiles = (primary.test?.exclude ?? []).filter((entry) => /test\/.*\.test\.ts$/.test(entry));
    expect(excludedTestFiles).toEqual([...EVM_TEST_SCOPES.chain.files]);
  });
});
