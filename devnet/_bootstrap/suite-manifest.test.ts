// Drift-guard for the single-source suite manifest (devnet/suites.json). Pure
// filesystem/JSON — needs NO live devnet — so it runs fast in CI and locally,
// catching the classic failure mode where a new suite is added under devnet/ but
// forgotten in the sweep list / pnpm-workspace / package.json (otReviewAgent #1397).
import { afterEach, describe, it, expect } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
const SWEEP_PREFLIGHT = resolve(ROOT, 'scripts/devnet-shared-sweep-preflight.mjs');
const fixtureDirs: string[] = [];

function wallet(nodeNumber: number, walletIndex: number) {
  const value = nodeNumber * 10 + walletIndex + 1;
  return {
    address: `0x${value.toString(16).padStart(40, '0')}`,
    privateKey: `0x${value.toString(16).padStart(64, '0')}`,
  };
}

function createSharedSweepFixture(selectedWalletIndex: number): string {
  const root = mkdtempSync(resolve(tmpdir(), 'dkg-shared-sweep-'));
  fixtureDirs.push(root);
  for (let nodeNumber = 1; nodeNumber <= manifest.sharedSweep.nodeCount; nodeNumber += 1) {
    const nodeDir = resolve(root, `node${nodeNumber}`);
    const wallets = [0, 1, 2].map((index) => wallet(nodeNumber, index));
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      resolve(nodeDir, 'config.json'),
      JSON.stringify({ publisher: { enabled: true } }),
    );
    writeFileSync(resolve(nodeDir, 'wallets.json'), JSON.stringify({ wallets }));
    writeFileSync(
      resolve(nodeDir, 'publisher-wallets.json'),
      JSON.stringify({ wallets: [wallets[selectedWalletIndex]] }),
    );
  }
  return root;
}

function runSharedSweepPreflight(devnetDir: string) {
  return spawnSync(process.execPath, [SWEEP_PREFLIGHT], {
    encoding: 'utf8',
    env: { ...process.env, DEVNET_DIR: devnetDir },
  });
}

afterEach(() => {
  for (const path of fixtureDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

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

  it('accepts the manifest-declared shared-sweep publisher topology', () => {
    const result = runSharedSweepPreflight(
      createSharedSweepFixture(manifest.sharedSweep.publisherWalletIndex),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('6 nodes, publisher wallet index 1');
  });

  it('rejects the ordinary wallet-0 publisher topology with exact recovery', () => {
    const result = runSharedSweepPreflight(createSharedSweepFixture(0));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'node1 publisher wallet does not match operational wallet index 1',
    );
    expect(result.stderr).toContain(
      'DEVNET_ENABLE_PUBLISHER=1 DEVNET_PUBLISHER_WALLET_INDEX=1 ./scripts/devnet.sh start 6',
    );
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
