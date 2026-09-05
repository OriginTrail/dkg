import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('large raw IRI scanner regression', () => {
  it('does not rescan a raw IRI because inert text looks like UCHAR', () => {
    const runner = fileURLToPath(new URL(
      './fixtures/sparql-large-iri-benchmark.mjs',
      import.meta.url,
    ));
    const { rawMs, inertUcharMs } = JSON.parse(execFileSync(
      process.execPath,
      ['--jitless', runner],
      {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )) as { rawMs: number; inertUcharMs: number };

    expect(rawMs).toBeLessThan(500);
    expect(
      inertUcharMs / rawMs,
      `isolated samples: raw=${rawMs.toFixed(3)}ms inert-UCHAR=${inertUcharMs.toFixed(3)}ms`,
    ).toBeLessThan(1.4);
  }, 25_000);
});
