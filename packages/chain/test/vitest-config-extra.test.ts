/** Guard lifecycle coverage across the primary and required EVM CI lanes. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import primary from '../vitest.config';
import integration from '../../../vitest.evm-integration';

describe('chain lifecycle test ownership [CH-1]', () => {
  it('keeps broad test discovery in both configurations', () => {
    expect(primary.test?.include).toContain('test/**/*.test.ts');
    expect(integration.test?.include).toContain('test/**/*.test.ts');
  });

  it('assigns the adapter lifecycle to the dedicated real-EVM runner', () => {
    const adapter = 'test/evm-adapter.test.ts';
    expect(primary.test?.exclude).toContain(adapter);
    expect(integration.test?.exclude ?? []).toEqual([]);
    const runner = readFileSync(join(import.meta.dirname, '../../../scripts/test-evm-integration.sh'), 'utf8');
    expect(runner).toContain('packages/chain/test/evm-adapter.test.ts');
    expect(runner).toContain('--config "$ROOT/vitest.evm-integration.ts"');
  });

  it('excludes archives without dropping other active lifecycle files', () => {
    expect(primary.test?.exclude).toContain('test/archive/**');
    const excludedTestFiles = (primary.test?.exclude ?? []).filter((entry) => /test\/.*\.test\.ts$/.test(entry));
    expect(excludedTestFiles).toEqual(['test/evm-adapter.test.ts']);
  });
});
