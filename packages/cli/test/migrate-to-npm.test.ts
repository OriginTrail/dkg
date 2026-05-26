/**
 * Unit tests for `dkg migrate-to-npm`.
 *
 * Strategy:
 *   - `buildMigrationPlan` is pure (FS injected via `exists`) → table-driven
 *     tests covering load-bearing/cosmetic split, blockers (alive +
 *     orphan), --force semantics, idempotent re-run, config skip when
 *     already at npm.
 *   - `applyPlan` is exercised against a real `mkdtemp` fixture for the
 *     happy-path renames + config write. Refusal-when-blockers test uses
 *     an injected throwing IO so we don't have to spin a fixture.
 *   - `renderPlan` gets a snapshot-style assertion for the dry-run
 *     header + a no-op idempotent variant.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMigrationPlan,
  applyPlan,
  renderPlan,
  findDkgMonorepoRootFromCwd,
  resolveMigrationDkgHome,
  type ApplyPlanIo,
  type MigrationPlan,
} from '../src/migrate-to-npm.js';

const REPO = '/tmp/fake-dkg-v9';
const DKG_HOME = '/tmp/.dkg';

function existsOf(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('buildMigrationPlan — load-bearing detection', () => {
  it('emits a load-bearing rename for package.json', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: undefined,
      exists: existsOf([`${REPO}/package.json`]),
    });
    expect(plan.alreadyMigrated).toBe(false);
    const renames = plan.actions.filter((a) => a.kind === 'rename');
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      kind: 'rename',
      from: `${REPO}/package.json`,
      to: `${REPO}/package.json.pre-npm-migration-ts`,
      loadBearing: true,
    });
  });

  it('emits a cosmetic rename for .git but flags it as cosmetic, not load-bearing', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: undefined,
      exists: existsOf([`${REPO}/package.json`, `${REPO}/.git`]),
    });
    const renames = plan.actions.filter((a) => a.kind === 'rename');
    expect(renames.map((r) => ({ name: (r as { from: string }).from.split('/').pop(), lb: (r as { loadBearing: boolean }).loadBearing }))).toEqual([
      { name: 'package.json', lb: true },
      { name: '.git', lb: false },
    ]);
  });

  it('skips renames for artifacts that do not exist (e.g. .git already removed)', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: undefined,
      exists: existsOf([`${REPO}/package.json`]),
    });
    expect(plan.actions.filter((a) => a.kind === 'rename')).toHaveLength(1);
  });
});

describe('buildMigrationPlan — alreadyMigrated short-circuit', () => {
  it('returns alreadyMigrated when source is npm-pinned and no markers remain', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'npm',
      exists: existsOf([]),
    });
    expect(plan).toEqual({ actions: [], warnings: [], blockers: [], alreadyMigrated: true });
  });

  // Codex review (3301781920): regression — undefined source on a
  // partially-migrated tree must keep going and emit the config-write
  // pin, not short-circuit. Previously this case returned alreadyMigrated.
  it('does NOT short-circuit when source is undefined even if no markers (partial migration repair path)', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: undefined,
      exists: existsOf([]),
    });
    expect(plan.alreadyMigrated).toBe(false);
    const write = plan.actions.find((a) => a.kind === 'config-write');
    expect(write).toMatchObject({
      kind: 'config-write',
      key: 'autoUpdate.source',
      value: 'npm',
    });
  });

  it('does NOT short-circuit when source is "git" even if no markers (operator pinned git explicitly)', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf([]),
    });
    expect(plan.alreadyMigrated).toBe(false);
    expect(plan.actions.find((a) => a.kind === 'config-write')).toBeDefined();
  });

  it('does NOT short-circuit when package.json is gone but .git still needs cleanup', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: undefined,
      exists: existsOf([`${REPO}/.git`]),
    });
    expect(plan.alreadyMigrated).toBe(false);
    expect(plan.actions.some((a) => a.kind === 'rename' && a.from === `${REPO}/.git`)).toBe(true);
    expect(plan.actions.find((a) => a.kind === 'config-write')).toBeDefined();
  });
});

describe('buildMigrationPlan — config-write action', () => {
  it('writes autoUpdate.source = "npm" when current source is "git"', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`]),
    });
    const write = plan.actions.find((a) => a.kind === 'config-write');
    expect(write).toMatchObject({
      kind: 'config-write',
      configPath: `${DKG_HOME}/config.json`,
      configFormat: 'json',
      key: 'autoUpdate.source',
      value: 'npm',
    });
  });

  it('targets config.yaml when the active install is yaml-only', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`, `${DKG_HOME}/config.yaml`]),
    });
    const write = plan.actions.find((a) => a.kind === 'config-write');
    expect(write).toMatchObject({
      kind: 'config-write',
      configPath: `${DKG_HOME}/config.yaml`,
      configFormat: 'yaml',
    });
  });

  it('skips the config-write when source is already "npm"', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'npm',
      exists: existsOf([`${REPO}/package.json`]),
    });
    expect(plan.actions.find((a) => a.kind === 'config-write')).toBeUndefined();
  });
});

describe('buildMigrationPlan — alive-check blocker', () => {
  it('emits a blocker when the daemon is alive and --force is NOT passed', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: true,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`]),
    });
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toMatch(/daemon is alive/);
    expect(plan.warnings).toHaveLength(0);
  });

  it('downgrades the blocker to a warning when --force is passed', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: true,
      forceAliveBypass: true,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`]),
    });
    expect(plan.blockers).toHaveLength(0);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/--force was passed/);
  });
});

describe('buildMigrationPlan — orphan-home blocker', () => {
  it('hard-refuses (no --force override) when state would orphan', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: '/home/op/.dkg-dev',
      dkgHomePostMigration: '/home/op/.dkg',
      daemonAlive: false,
      forceAliveBypass: true,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`, '/home/op/.dkg-dev/daemon.pid']),
    });
    expect(plan.blockers.find((b) => b.includes('state-directory orphan'))).toBeDefined();
    expect(plan.blockers[0]).toMatch(/mv \/home\/op\/\.dkg-dev \/home\/op\/\.dkg/);
    expect(plan.blockers[0]).toMatch(/DKG_HOME=\/home\/op\/\.dkg-dev/);
  });

  it('checks orphan-home state before the already-migrated fast path', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: '/home/op/.dkg-dev',
      dkgHomePostMigration: '/home/op/.dkg',
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'npm',
      exists: existsOf(['/home/op/.dkg-dev/auth.token']),
    });
    expect(plan.alreadyMigrated).toBe(false);
    expect(plan.blockers.find((b) => b.includes('state-directory orphan'))).toBeDefined();
  });

  it('does not suggest plain mv when the post-migration home already exists', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: '/home/op/.dkg-dev',
      dkgHomePostMigration: '/home/op/.dkg',
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf(['/home/op/.dkg-dev/auth.token', '/home/op/.dkg']),
    });

    expect(plan.blockers[0]).toContain('Destination /home/op/.dkg already exists');
    expect(plan.blockers[0]).toContain('Merge/copy the state');
    expect(plan.blockers[0]).not.toMatch(/mv \/home\/op\/\.dkg-dev \/home\/op\/\.dkg/);
  });

  it('does not flag the orphan blocker when homes match', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: '/home/op/.dkg',
      dkgHomePostMigration: '/home/op/.dkg',
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`]),
    });
    expect(plan.blockers.find((b) => b.includes('state-directory orphan'))).toBeUndefined();
  });

  it('does not flag the orphan blocker for an empty derived home', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: '/home/op/.dkg-dev',
      dkgHomePostMigration: '/home/op/.dkg',
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`]),
    });
    expect(plan.blockers.find((b) => b.includes('state-directory orphan'))).toBeUndefined();
  });
});

describe('applyPlan — refuses to mutate when blockers present', () => {
  it('throws synchronously rather than partially-mutating', async () => {
    const planWithBlockers: MigrationPlan = {
      actions: [{ kind: 'rename', from: '/x', to: '/y', loadBearing: true, reason: 'r' }],
      warnings: [],
      blockers: ['something is wrong'],
      alreadyMigrated: false,
    };
    let renames = 0;
    const io: ApplyPlanIo = {
      rename: async () => {
        renames += 1;
      },
      readFile: async () => null,
      writeFile: async () => {},
      mkdir: async () => {},
    };
    await expect(applyPlan(planWithBlockers, () => {}, io)).rejects.toThrow(/blocker\(s\) present/);
    expect(renames).toBe(0);
  });

  it('validates malformed config JSON before renaming source-tree markers', async () => {
    const plan: MigrationPlan = {
      actions: [
        { kind: 'rename', from: '/repo/package.json', to: '/repo/package.json.bak', loadBearing: true, reason: 'r' },
        { kind: 'config-write', configPath: '/state/config.json', configFormat: 'json', key: 'autoUpdate.source', value: 'npm', reason: 'r' },
      ],
      warnings: [],
      blockers: [],
      alreadyMigrated: false,
    };
    let renames = 0;
    const io: ApplyPlanIo = {
      rename: async () => {
        renames += 1;
      },
      readFile: async () => '{bad json',
      writeFile: async () => {},
      mkdir: async () => {},
    };
    await expect(applyPlan(plan, () => {}, io)).rejects.toThrow();
    expect(renames).toBe(0);
  });

  it('validates scalar autoUpdate before renaming source-tree markers', async () => {
    const plan: MigrationPlan = {
      actions: [
        { kind: 'rename', from: '/repo/package.json', to: '/repo/package.json.bak', loadBearing: true, reason: 'r' },
        { kind: 'config-write', configPath: '/state/config.json', configFormat: 'json', key: 'autoUpdate.source', value: 'npm', reason: 'r' },
      ],
      warnings: [],
      blockers: [],
      alreadyMigrated: false,
    };
    let renames = 0;
    const io: ApplyPlanIo = {
      rename: async () => {
        renames += 1;
      },
      readFile: async () => JSON.stringify({ autoUpdate: 'git' }),
      writeFile: async () => {},
      mkdir: async () => {},
    };
    await expect(applyPlan(plan, () => {}, io)).rejects.toThrow(/autoUpdate must be an object/);
    expect(renames).toBe(0);
  });
});

describe('applyPlan — happy path on a real fixture', () => {
  it('renames load-bearing + cosmetic artifacts and writes the config', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dkg-migrate-test-'));
    try {
      const repoRoot = join(tmp, 'repo');
      const dkgHome = join(tmp, 'state');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(join(repoRoot, '.git'));
      await writeFile(join(repoRoot, 'package.json'), '{"name":"@origintrail-official/dkg-monorepo"}');
      const plan = buildMigrationPlan({
        repoRoot,
        backupSuffix: 'fixture',
        dkgHomeNow: dkgHome,
        dkgHomePostMigration: dkgHome,
        daemonAlive: false,
        forceAliveBypass: false,
        currentAutoUpdateSource: 'git',
        exists: existsSync,
      });
      expect(plan.blockers).toEqual([]);
      await applyPlan(plan, () => {});

      expect(existsSync(join(repoRoot, 'package.json'))).toBe(false);
      expect(existsSync(join(repoRoot, 'package.json.pre-npm-migration-fixture'))).toBe(true);
      expect(existsSync(join(repoRoot, '.git'))).toBe(false);
      expect(existsSync(join(repoRoot, '.git.pre-npm-migration-fixture'))).toBe(true);

      const cfg = JSON.parse(await readFile(join(dkgHome, 'config.json'), 'utf-8'));
      expect(cfg).toEqual({ autoUpdate: { source: 'npm' } });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('preserves existing autoUpdate fields when patching the dotted key', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dkg-migrate-test-'));
    try {
      const repoRoot = join(tmp, 'repo');
      const dkgHome = join(tmp, 'state');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(dkgHome, { recursive: true });
      await writeFile(join(repoRoot, 'package.json'), '{}');
      await writeFile(
        join(dkgHome, 'config.json'),
        JSON.stringify({
          name: 'beacon-01',
          autoUpdate: { enabled: true, checkIntervalMinutes: 30 },
        }),
      );
      const plan = buildMigrationPlan({
        repoRoot,
        backupSuffix: 'fixture',
        dkgHomeNow: dkgHome,
        dkgHomePostMigration: dkgHome,
        daemonAlive: false,
        forceAliveBypass: false,
        currentAutoUpdateSource: 'git',
        exists: existsSync,
      });
      await applyPlan(plan, () => {});
      const cfg = JSON.parse(await readFile(join(dkgHome, 'config.json'), 'utf-8'));
      expect(cfg).toEqual({
        name: 'beacon-01',
        autoUpdate: { enabled: true, checkIntervalMinutes: 30, source: 'npm' },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('preserves yaml-only config format when patching the dotted key', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dkg-migrate-test-'));
    try {
      const repoRoot = join(tmp, 'repo');
      const dkgHome = join(tmp, 'state');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(dkgHome, { recursive: true });
      await writeFile(join(repoRoot, 'package.json'), '{}');
      await writeFile(
        join(dkgHome, 'config.yaml'),
        [
          'name: beacon-01',
          'autoUpdate:',
          '  enabled: true',
          '  checkIntervalMinutes: 30',
          '',
        ].join('\n'),
      );
      const plan = buildMigrationPlan({
        repoRoot,
        backupSuffix: 'fixture',
        dkgHomeNow: dkgHome,
        dkgHomePostMigration: dkgHome,
        daemonAlive: false,
        forceAliveBypass: false,
        currentAutoUpdateSource: 'git',
        exists: existsSync,
      });
      await applyPlan(plan, () => {});
      expect(existsSync(join(dkgHome, 'config.json'))).toBe(false);
      const cfg = await readFile(join(dkgHome, 'config.yaml'), 'utf-8');
      expect(cfg).toContain('name: beacon-01');
      expect(cfg).toContain('source: npm');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('idempotent re-run after a successful migration is a no-op', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dkg-migrate-test-'));
    try {
      const repoRoot = join(tmp, 'repo');
      const dkgHome = join(tmp, 'state');
      await mkdir(repoRoot, { recursive: true });
      const planSecondRun = buildMigrationPlan({
        repoRoot,
        backupSuffix: 'fixture',
        dkgHomeNow: dkgHome,
        dkgHomePostMigration: dkgHome,
        daemonAlive: false,
        forceAliveBypass: false,
        currentAutoUpdateSource: 'npm',
        exists: existsSync,
      });
      expect(planSecondRun.alreadyMigrated).toBe(true);
      expect(planSecondRun.actions).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('renderPlan — operator-facing output', () => {
  it('renders alreadyMigrated as a one-line success', () => {
    const out = renderPlan({ actions: [], warnings: [], blockers: [], alreadyMigrated: true });
    expect(out).toMatch(/^Already migrated/);
  });

  it('tags load-bearing vs cosmetic renames distinctly', () => {
    const plan = buildMigrationPlan({
      repoRoot: REPO,
      backupSuffix: 'ts',
      dkgHomeNow: DKG_HOME,
      dkgHomePostMigration: DKG_HOME,
      daemonAlive: false,
      forceAliveBypass: false,
      currentAutoUpdateSource: 'git',
      exists: existsOf([`${REPO}/package.json`, `${REPO}/.git`]),
    });
    const out = renderPlan(plan);
    expect(out).toMatch(/\[LOAD-BEARING\].*package\.json/);
    expect(out).toMatch(/\[cosmetic\].*\.git/);
    expect(out).toMatch(/\[CONFIG\].*autoUpdate\.source/);
  });

  it('surfaces blockers with a dedicated section', () => {
    const plan: MigrationPlan = {
      actions: [],
      warnings: [],
      blockers: ['daemon is alive — refusing'],
      alreadyMigrated: false,
    };
    expect(renderPlan(plan)).toMatch(/Blockers \(must be resolved/);
  });
});

describe('findDkgMonorepoRootFromCwd — walk-up', () => {
  // Codex review (3300428735): regression — a globally installed `dkg`
  // resolves repoDir() to null even when the operator is cd-ed into the
  // monorepo they want to migrate. The CLI must walk up from cwd to
  // locate the real root so the load-bearing top-level package.json
  // gets renamed.
  it('returns the monorepo root when started from a subdirectory', () => {
    const isMonorepo = (dir: string) => dir === '/home/op/dkg-v9';
    expect(findDkgMonorepoRootFromCwd('/home/op/dkg-v9/packages/cli/dist', isMonorepo))
      .toBe('/home/op/dkg-v9');
  });

  it('returns null when no ancestor is a monorepo root', () => {
    const isMonorepo = () => false;
    expect(findDkgMonorepoRootFromCwd('/some/random/path', isMonorepo)).toBeNull();
  });

  it('returns startDir itself when it is the monorepo root', () => {
    const isMonorepo = (dir: string) => dir === '/repo';
    expect(findDkgMonorepoRootFromCwd('/repo', isMonorepo)).toBe('/repo');
  });

  it('integrates with buildMigrationPlan: cwd-walked root produces the load-bearing rename', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dkg-migrate-walkup-'));
    try {
      const repoRoot = join(tmp, 'dkg-v9');
      await mkdir(join(repoRoot, 'packages', 'cli'), { recursive: true });
      await writeFile(join(repoRoot, 'package.json'), '{}');
      // Mark the repo as a DKG monorepo per isDkgMonorepoRoot's contract.
      await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
      await writeFile(join(repoRoot, 'project.json'), '{}');
      await writeFile(
        join(repoRoot, 'packages', 'cli', 'package.json'),
        JSON.stringify({ name: '@origintrail-official/dkg' }),
      );
      const subDir = join(repoRoot, 'packages', 'cli');
      const found = findDkgMonorepoRootFromCwd(subDir);
      expect(found).toBe(repoRoot);
      // Sanity: the planner emits the load-bearing rename when handed
      // the walked-up root with a real package.json present.
      const plan = buildMigrationPlan({
        repoRoot: found!,
        backupSuffix: 'ts',
        dkgHomeNow: DKG_HOME,
        dkgHomePostMigration: DKG_HOME,
        daemonAlive: false,
        forceAliveBypass: false,
        currentAutoUpdateSource: 'git',
        exists: existsSync,
      });
      expect(plan.actions.some((a) => a.kind === 'rename' && a.from === join(repoRoot, 'package.json') && a.loadBearing)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('resolveMigrationDkgHome — partial-migration home selection', () => {
  // Codex review (3302171976): regression — a rerun from a
  // partially-migrated checkout must read/write the standalone home
  // (~/.dkg) because the live CLI is already in standalone mode
  // (repoDir() === null after the load-bearing rename), even though
  // the structural monorepo markers (pnpm-workspace.yaml, project.json,
  // packages/cli/package.json) remain on disk.
  it('returns ~/.dkg when detectedRepoRoot is null (live CLI is standalone)', () => {
    const home = resolveMigrationDkgHome({
      detectedRepoRoot: null,
      homeDir: '/home/op',
      env: {},
      configExists: false,
    });
    expect(home).toBe('/home/op/.dkg');
  });

  it('returns ~/.dkg-dev when detectedRepoRoot points at a real repo (live CLI in monorepo mode, no global config)', () => {
    const home = resolveMigrationDkgHome({
      detectedRepoRoot: '/home/op/dkg-v9',
      homeDir: '/home/op',
      env: {},
      configExists: false,
    });
    expect(home).toBe('/home/op/.dkg-dev');
  });

  it('returns ~/.dkg even with detectedRepoRoot when global config already exists (operator opted in)', () => {
    const home = resolveMigrationDkgHome({
      detectedRepoRoot: '/home/op/dkg-v9',
      homeDir: '/home/op',
      env: {},
      configExists: true,
    });
    expect(home).toBe('/home/op/.dkg');
  });
});
