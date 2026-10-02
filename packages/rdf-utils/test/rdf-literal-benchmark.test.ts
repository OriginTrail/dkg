import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/rdf-literal-escape-benchmark.mjs', import.meta.url));

describe('literal escape benchmark provenance', () => {
  it('rejects a requested baseline ref before any worker is started', () => {
    const result = spawnSync(process.execPath, [script, '--baseline=HEAD', '--iterations=1'], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the legacy baseline is fixed');
    expect(result.stdout).toBe('');
  });
});
