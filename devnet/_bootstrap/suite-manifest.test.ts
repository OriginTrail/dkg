// Drift-guard for the single-source suite manifest (devnet/suites.json). Pure
// filesystem/JSON — needs NO live devnet — so it runs fast in CI and locally,
// catching the classic failure mode where a new suite is added under devnet/ but
// forgotten in the sweep list / pnpm-workspace / package.json (otReviewAgent #1397).
import { describe, it, expect } from 'vitest';
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

const DEVNET = resolve(import.meta.dirname, '..');
const ROOT = resolve(DEVNET, '..');
const manifest = JSON.parse(readFileSync(resolve(DEVNET, 'suites.json'), 'utf8')) as {
  sharedSweep: {
    nodeCount: number;
    publisherWalletIndex: number;
  };
  prCoverage: string[];
  all: string[];
};
// Suite dirs actually present on disk: devnet/<x>/ with a vitest.config.ts, minus
// the underscore-prefixed infra dirs (_bootstrap).
const onDisk = readdirSync(DEVNET, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
  .map((e) => e.name)
  .filter((n) => existsSync(resolve(DEVNET, n, 'vitest.config.ts')))
  .sort();

describe('devnet suite manifest (suites.json) — drift guard', () => {
  it('declares the issue #2440 shared-sweep topology explicitly', () => {
    expect(manifest.prCoverage).toContain('pr2440-pca-cg-registration');
    expect(manifest.sharedSweep).toEqual({
      nodeCount: 6,
      publisherWalletIndex: 1,
    });
  });

  it('prCoverage ⊆ all', () => {
    const missing = manifest.prCoverage.filter((s) => !manifest.all.includes(s));
    expect(missing, `prCoverage entries not in all: ${missing.join(', ')}`).toEqual([]);
  });

  it('all == on-disk suites (no untracked or stale entries)', () => {
    const sorted = [...manifest.all].sort();
    const untracked = onDisk.filter((s) => !manifest.all.includes(s));
    const stale = manifest.all.filter((s) => !onDisk.includes(s));
    expect(untracked, `suites on disk but MISSING from suites.json: ${untracked.join(', ')}`).toEqual([]);
    expect(stale, `suites in suites.json with NO dir on disk: ${stale.join(', ')}`).toEqual([]);
    expect(sorted).toEqual(onDisk);
  });

  it('every suite in all has a vitest.config.ts', () => {
    for (const s of manifest.all) {
      expect(existsSync(resolve(DEVNET, s, 'vitest.config.ts')), `missing ${s}/vitest.config.ts`).toBe(true);
    }
  });

  it('every suite in all is a pnpm-workspace package', () => {
    const ws = readFileSync(resolve(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    // entries look like:  - "devnet/<suite>"
    const listed = new Set(
      [...ws.matchAll(/["']?devnet\/([^"'\s]+)["']?/g)].map((m) => m[1]),
    );
    const missing = manifest.all.filter((s) => !listed.has(s));
    expect(missing, `suites not in pnpm-workspace.yaml: ${missing.join(', ')}`).toEqual([]);
  });

  it('every suite in all has a package.json test:devnet:* script pointing at its config', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    // Collect the dirs referenced by every `--config devnet/<dir>/vitest.config.ts`
    // (script NAME may not match dir, e.g. v10-e2e → v10-end-to-end — so match the PATH).
    const scripted = new Set<string>();
    for (const cmd of Object.values(pkg.scripts ?? {})) {
      const m = /--config\s+devnet\/([^/]+)\/vitest\.config\.ts/.exec(cmd);
      if (m) scripted.add(m[1]);
    }
    const missing = manifest.all.filter((s) => !scripted.has(s));
    expect(missing, `suites with no test:devnet:* script: ${missing.join(', ')}`).toEqual([]);
  });

  it('is internally sound: all dirs exist and are directories', () => {
    for (const s of manifest.all) {
      const p = resolve(DEVNET, s);
      expect(existsSync(p) && statSync(p).isDirectory(), `${s} is not a directory`).toBe(true);
    }
  });
});
