// Drift-guard for the single-source suite manifest (devnet/suites.json). Pure
// filesystem/JSON — needs NO live devnet — so it runs fast in CI and locally,
// catching the classic failure mode where a new suite is added under devnet/ but
// forgotten in the sweep list / pnpm-workspace / package.json (otReviewAgent #1397).
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  scheduleSweepPhase,
  selectSweepSuites,
} from '../../scripts/lib/sweep-suite-selector.mjs';

const DEVNET = resolve(import.meta.dirname, '..');
const ROOT = resolve(DEVNET, '..');
const manifest = JSON.parse(readFileSync(resolve(DEVNET, 'suites.json'), 'utf8')) as {
  sharedSweep: {
    nodeCount: number;
    publisherWalletIndex: number;
  };
  prCoverage: string[];
  baselineOnly: string[];
  all: string[];
};
const SWEEP_SELECTOR = resolve(ROOT, 'scripts/lib/sweep-suite-selector.mjs');
const SWEEP_PHASE_SCHEDULE = resolve(ROOT, 'scripts/lib/sweep-phase-schedule.sh');

function runScheduledPhase(phase: 'baseline' | 'stability', round = 0, override?: string) {
  const args = [SWEEP_SELECTOR, resolve(DEVNET, 'suites.json'), phase, String(round)];
  if (override !== undefined) args.push(override);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [logTag, suite] = line.split('\t');
    return { logTag, suite };
  });
}
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

  it('baselineOnly is a duplicate-free subset of prCoverage', () => {
    const missing = manifest.baselineOnly.filter((s) => !manifest.prCoverage.includes(s));
    expect(missing, `baselineOnly entries not in prCoverage: ${missing.join(', ')}`).toEqual([]);
    expect(new Set(manifest.baselineOnly).size).toBe(manifest.baselineOnly.length);
  });

  it('has no duplicate suite entries', () => {
    for (const [name, suites] of [
      ['prCoverage', manifest.prCoverage],
      ['all', manifest.all],
    ] as const) {
      expect(new Set(suites).size, `${name} contains duplicate entries`).toBe(suites.length);
    }
  });

  it('schedules baselineOnly once and repeatable suites in every stability round', () => {
    const selection = selectSweepSuites(manifest);

    expect(selection.baseline).toEqual([...manifest.prCoverage, 'v10-end-to-end']);
    expect(selection.stability).toEqual([
      ...manifest.prCoverage.filter((suite) => !manifest.baselineOnly.includes(suite)),
      'v10-end-to-end',
    ]);
    expect(new Set(selection.baseline).size, 'baseline selection contains duplicates').toBe(
      selection.baseline.length,
    );
    expect(new Set(selection.stability).size, 'stability selection contains duplicates').toBe(
      selection.stability.length,
    );

    const invocations = [
      ...scheduleSweepPhase(selection, 'baseline'),
      ...scheduleSweepPhase(selection, 'stability', 1),
      ...scheduleSweepPhase(selection, 'stability', 2),
    ];
    const baselineInvocations = runScheduledPhase('baseline');
    const firstStabilityRound = runScheduledPhase('stability', 1);
    const secondStabilityRound = runScheduledPhase('stability', 2);
    expect(baselineInvocations).toHaveLength(selection.baseline.length);
    expect(firstStabilityRound).toHaveLength(selection.stability.length);
    expect(secondStabilityRound).toHaveLength(selection.stability.length);

    const operationalInvocations = [
      ...baselineInvocations,
      ...firstStabilityRound,
      ...secondStabilityRound,
    ];
    expect(operationalInvocations.map(({ suite }) => suite)).toEqual(
      invocations.map(({ suite }) => suite),
    );

    const invocationCount = (suite: string) =>
      operationalInvocations.filter((invocation) => invocation.suite === suite).length;
    for (const suite of manifest.baselineOnly) expect(invocationCount(suite)).toBe(1);
    for (const suite of selection.stability) expect(invocationCount(suite)).toBe(3);
    expect(operationalInvocations[0].logTag).toBe(`P1-${selection.baseline[0]}`);
    expect(operationalInvocations.at(-1)?.logTag).toBe(
      `P2-r2-${selection.stability.at(-1)}`,
    );
  });

  it('preserves an explicit STABILITY_SUITES override verbatim', () => {
    const override = 'pr2440-pca-cg-registration v10-core-flows';
    const selection = selectSweepSuites(manifest, override);
    expect(selection.stability).toEqual(override.split(' '));
    expect(runScheduledPhase('stability', 1, override).map(({ suite }) => suite)).toEqual(
      override.split(' '),
    );
  });

  it.runIf(process.platform !== 'win32')(
    'aborts before a phase loop when the selector fails or returns an empty schedule',
    () => {
      const fixture = mkdtempSync(resolve(tmpdir(), 'dkg-sweep-phase-'));
      try {
        const manifestPath = resolve(fixture, 'suites.json');
        writeFileSync(manifestPath, '{}');
        for (const [name, source] of [
          ['failed-selector.mjs', 'process.exit(7);'],
          ['empty-selector.mjs', ''],
        ] as const) {
          const selectorPath = resolve(fixture, name);
          writeFileSync(selectorPath, source);
          const result = spawnSync('bash', ['-c', [
            'source "$SWEEP_PHASE_LOADER"',
            'capture_sweep_phase_schedule baseline 0 || exit 2',
            'printf "unexpected:%s" "$SWEEP_PHASE_SCHEDULE"',
          ].join('\n')], {
            encoding: 'utf8',
            env: {
              ...process.env,
              SWEEP_PHASE_LOADER: SWEEP_PHASE_SCHEDULE,
              SWEEP_SELECTOR: selectorPath,
              SUITES_JSON: manifestPath,
              STABILITY_OVERRIDE: '',
            },
          });
          expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
          expect(result.stdout).not.toContain('unexpected:');
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps a validated phase schedule in the parent shell',
    () => {
      const result = spawnSync('bash', ['-c', [
        'source "$SWEEP_PHASE_LOADER"',
        'capture_sweep_phase_schedule baseline 0 || exit 2',
        'printf "%s" "$SWEEP_PHASE_SCHEDULE"',
      ].join('\n')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SWEEP_PHASE_LOADER: SWEEP_PHASE_SCHEDULE,
          SWEEP_SELECTOR,
          SUITES_JSON: resolve(DEVNET, 'suites.json'),
          STABILITY_OVERRIDE: '',
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(
        selectSweepSuites(manifest).baseline.length,
      );
    },
  );

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
