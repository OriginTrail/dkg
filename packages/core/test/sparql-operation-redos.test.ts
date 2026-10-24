import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function measureGrowthInIsolatedProcess() {
  const runner = fileURLToPath(new URL(
    './fixtures/sparql-redos-benchmark.mjs',
    import.meta.url,
  ));
  return JSON.parse(execFileSync(
    process.execPath,
    ['--jitless', runner],
    {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )) as { smallMs: number; largeMs: number };
}

describe('classifySparqlOperation ReDoS regression', () => {
  it('keeps adversarial dangling-PREFIX growth bounded', () => {
    const { smallMs, largeMs } = measureGrowthInIsolatedProcess();

    // The legacy nested regex took much longer than 10 seconds at 10k.
    expect(largeMs).toBeLessThan(1000);
    // Both samples are above V8's large-object allocation boundary. A 4x
    // input may take at most 10x as long, rejecting quadratic/backtracking
    // growth without comparing different allocator regimes.
    expect(
      largeMs / smallMs,
      `isolated scaling samples: small=${smallMs.toFixed(6)}ms ` +
      `large=${largeMs.toFixed(6)}ms`,
    ).toBeLessThan(10);
  }, 25_000);
});
