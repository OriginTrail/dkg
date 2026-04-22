/**
 * packages/chain audit coverage tests.
 *
 * Audit findings covered:
 *
 *   CH-1 (CRITICAL) — The shipped `vitest.config.ts` EXPLICITLY excludes
 *                     `test/evm-adapter.test.ts` and `test/evm-e2e.test.ts`.
 *                     Those two files hold the bulk of the EVMChainAdapter
 *                     lifecycle coverage (reserveUALRange, publishKA, update,
 *                     extendStorage, transferNamespace, listenForEvents,
 *                     plus the V10 multi-validator publish round-trip). With
 *                     the exclude in place, `pnpm --filter @origintrail-official/dkg-chain test`
 *                     (the default CI entry point) is GREEN even when the
 *                     on-chain publish path is broken end-to-end.
 *
 * This test asserts the raw config file does NOT carry those excludes. It
 * will stay RED until the excludes are removed — that RED state IS the bug
 * evidence. See BUGS_FOUND.md CH-1.
 *
 * Per QA policy: do NOT modify production code / configs. The failing test
 * is the finding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = join(import.meta.dirname, '..', 'vitest.config.ts');

function loadConfigSource(): string {
  return readFileSync(CONFIG_PATH, 'utf8');
}

function parseStringArrayLiteral(source: string, field: 'include' | 'exclude'): string[] | null {
  // Minimal heuristic parser: find `field: [ ... ]` and split on quoted
  // string literals. Config is hand-authored so this does not need to be
  // a real JS parser — any reasonable edit preserves the shape.
  const re = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`);
  const match = source.match(re);
  if (!match) return null;
  const body = match[1];
  const strings: string[] = [];
  const strRe = /['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(body)) !== null) {
    strings.push(m[1]);
  }
  return strings;
}

describe('vitest.config.ts — default run must include full lifecycle suite [CH-1]', () => {
  it('has an include glob that covers all test files', () => {
    const src = loadConfigSource();
    const includes = parseStringArrayLiteral(src, 'include');
    expect(includes).not.toBeNull();
    // The canonical include is `test/**/*.test.ts` — if the project narrows
    // this to a subset, this test pins the intention so a silent narrowing
    // is flagged.
    expect(includes).toContain('test/**/*.test.ts');
  });

  it('does NOT exclude evm-adapter.test.ts from the default run', () => {
    const src = loadConfigSource();
    const excludes = parseStringArrayLiteral(src, 'exclude') ?? [];
    // PROD-BUG (config): today the config ships with
    //   exclude: ['test/evm-adapter.test.ts', 'test/evm-e2e.test.ts']
    // which silently drops lifecycle coverage. This expectation will stay
    // red until that line is removed. See BUGS_FOUND.md CH-1.
    expect(excludes).not.toContain('test/evm-adapter.test.ts');
  });

  it('does NOT exclude evm-e2e.test.ts from the default run', () => {
    const src = loadConfigSource();
    const excludes = parseStringArrayLiteral(src, 'exclude') ?? [];
    expect(excludes).not.toContain('test/evm-e2e.test.ts');
  });

  it('exclude list (if present) only contains build artifacts / fixtures', () => {
    const src = loadConfigSource();
    const excludes = parseStringArrayLiteral(src, 'exclude') ?? [];
    // Any `.test.ts` file inside `test/` being explicitly excluded is a
    // RED flag — skipping a test file is almost always a mistake that needs
    // to be an `it.skip(...)` or a CI matrix, not a config-level blacklist.
    const excludedTestFiles = excludes.filter(
      (entry) => /test\/.*\.test\.ts$/.test(entry),
    );
    expect(excludedTestFiles).toEqual([]);
  });
});
