/**
 * Tests for `dkg doctor` (OT-RFC-41 §4.7).
 *
 * Each check is exercised through a fixture {@link DoctorDeps} —
 * an in-memory fake file-system, stubbed fetch + runCommand. The
 * real production deps (createProductionDeps) exist for the CLI
 * wrapper and are exercised indirectly through the orchestrator's
 * dispatch; here we cover the pure-function check bodies.
 *
 * Coverage:
 *   - state-summary 18-field assertion (§4.7.0)
 *   - orphan-repos check (§4.7.1): stray vs. active-daemon clone
 *   - config-sanity check (§4.7.2): nodeRole / apiPort /
 *     deprecated fields / malformed JSON
 *   - install-layout check (§4.7.3): Edge legacy slot / Core
 *     missing symlink / Core partial slot / Core `.git`-in-slot
 *   - version-skew check (§4.7.4): Edge ahead-of-daemon and
 *     daemon-ahead-of-npm; Core slot-vs-daemon mismatch
 *   - served-ui-mismatch check (§4.7.5): meta-version mismatch +
 *     unreachable-daemon skip
 *   - plugin-root check (§4.7.6): bare-name plugin not in stable
 *     plugin root
 *
 * Production wiring (CLI flag parsing, exit codes, JSON output
 * shape) is covered separately by the integration smoke tests.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runDoctor, collectStateSummary, ALL_CHECK_IDS } from '../src/doctor/index.js';
import type { DoctorDeps } from '../src/doctor/types.js';
import { runOrphanReposCheck } from '../src/doctor/checks/orphan-repos.js';
import { runConfigSanityCheck } from '../src/doctor/checks/config-sanity.js';
import { runInstallLayoutCheck } from '../src/doctor/checks/install-layout.js';
import { runVersionSkewCheck } from '../src/doctor/checks/version-skew.js';
import { runServedUiMismatchCheck } from '../src/doctor/checks/served-ui-mismatch.js';
import { runPluginRootCheck } from '../src/doctor/checks/plugin-root.js';

/**
 * In-memory file system. Each entry is either a `string`
 * (regular file contents) or a `symlink:<target>` (symlink).
 * Directories are implicit — any parent of a registered file
 * counts as a directory.
 */
interface FakeFS {
  [path: string]: string;
}

function normaliseFsPaths(fs: FakeFS): Map<string, string> {
  const m = new Map<string, string>();
  for (const [p, v] of Object.entries(fs)) {
    m.set(p.replace(/\/+$/, ''), v);
  }
  return m;
}

interface DepsOverrides {
  fs?: FakeFS;
  dkgHome?: string;
  home?: string;
  cwd?: string;
  apiPort?: number;
  isMonorepo?: boolean;
  monorepoRoot?: string | null;
  extraScanRoots?: string[];
  skipChecks?: string[];
  /** GET /api/status JSON; null = unreachable. */
  apiStatus?: Record<string, unknown> | null;
  /** GET /ui/ HTML body; null = unreachable. */
  uiHtml?: string | null;
  /** Stubbed `which dkg` / `<cli> --version` / `npm root -g` / `ps -o`. */
  commands?: Record<string, { stdout?: string; stderr?: string; code: number } | null>;
  /** `process.env.DKG_HOME` value at invocation. */
  dkgHomeEnv?: string | null;
}

function makeDeps(over: DepsOverrides = {}): DoctorDeps {
  const fs = normaliseFsPaths(over.fs ?? {});
  const dkgHome = over.dkgHome ?? '/test/.dkg';
  const home = over.home ?? '/test';
  const isDir = (path: string): boolean => {
    const target = path.replace(/\/+$/, '');
    for (const k of fs.keys()) {
      if (k === target) {
        const v = fs.get(k)!;
        if (v.startsWith('dir:')) return true;
        return false;
      }
      if (k.startsWith(target + '/')) return true;
    }
    return false;
  };
  const isSymlink = (path: string): boolean => {
    const v = fs.get(path.replace(/\/+$/, ''));
    return typeof v === 'string' && v.startsWith('symlink:');
  };
  return {
    dkgHome,
    dkgHomeEnv: over.dkgHomeEnv ?? null,
    cwd: over.cwd ?? '/test/work',
    home,
    apiPort: over.apiPort ?? 9200,
    isMonorepo: over.isMonorepo ?? false,
    monorepoRoot: over.monorepoRoot ?? null,
    extraScanRoots: over.extraScanRoots ?? [],
    skipChecks: over.skipChecks ?? [],

    exists(path) {
      const trimmed = path.replace(/\/+$/, '');
      if (fs.has(trimmed)) return true;
      return isDir(trimmed);
    },
    async readFile(path) {
      const v = fs.get(path.replace(/\/+$/, ''));
      if (v === undefined) return null;
      if (v.startsWith('symlink:') || v.startsWith('dir:')) return null;
      return v;
    },
    async readlink(path) {
      const v = fs.get(path.replace(/\/+$/, ''));
      if (typeof v === 'string' && v.startsWith('symlink:')) {
        return v.slice('symlink:'.length);
      }
      return null;
    },
    async stat(path) {
      const trimmed = path.replace(/\/+$/, '');
      const v = fs.get(trimmed);
      if (v !== undefined) {
        return {
          mtimeMs: 1700000000000,
          uid: 1000,
          isDirectory: v.startsWith('dir:'),
          isSymbolicLink: v.startsWith('symlink:'),
        };
      }
      if (isDir(trimmed)) {
        return { mtimeMs: 1700000000000, uid: 1000, isDirectory: true, isSymbolicLink: false };
      }
      return null;
    },
    async readdir(path) {
      const target = path.replace(/\/+$/, '');
      const direct = new Set<string>();
      const entries: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }> = [];
      for (const k of fs.keys()) {
        if (!k.startsWith(target + '/')) continue;
        const rest = k.slice(target.length + 1);
        const name = rest.split('/')[0];
        if (direct.has(name)) continue;
        direct.add(name);
        const childPath = join(target, name);
        const childVal = fs.get(childPath);
        const childIsDir = !childVal || childVal.startsWith('dir:') || isDir(childPath);
        const childIsSymlink = typeof childVal === 'string' && childVal.startsWith('symlink:');
        entries.push({ name, isDirectory: childIsDir, isSymbolicLink: childIsSymlink });
      }
      return entries;
    },
    async runCommand(cmd, args) {
      const key = `${cmd} ${args.join(' ')}`;
      if (over.commands && key in over.commands) {
        const v = over.commands[key];
        if (v === null) return null;
        return { stdout: v.stdout ?? '', stderr: v.stderr ?? '', code: v.code };
      }
      // Default: command not found.
      return null;
    },
    async fetchJson(url) {
      if (url.endsWith('/api/status')) return over.apiStatus ?? null;
      return null;
    },
    async fetchText(url) {
      if (url.includes('/ui/')) return over.uiHtml ?? null;
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// state-summary (§4.7.0)
// ---------------------------------------------------------------------------

describe('collectStateSummary (§4.7.0)', () => {
  it('reports all 18 fields, falling back to null when data is unavailable', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
      },
    });
    const s = await collectStateSummary(deps);

    // daemon.* — 9 fields including unreachableReason
    expect(s.daemon).toHaveProperty('pid');
    expect(s.daemon).toHaveProperty('entryPoint');
    expect(s.daemon).toHaveProperty('version');
    expect(s.daemon).toHaveProperty('commit');
    expect(s.daemon).toHaveProperty('commitShort');
    expect(s.daemon).toHaveProperty('buildTime');
    expect(s.daemon).toHaveProperty('distTag');
    expect(s.daemon).toHaveProperty('installMode');
    expect(s.daemon).toHaveProperty('nodeRole');
    expect(s.daemon.nodeRole).toBe('edge');

    // cli.* — 2 fields
    expect(s.cli).toHaveProperty('globalPath');
    expect(s.cli).toHaveProperty('version');

    // paths.* — 5 fields
    expect(s.paths).toHaveProperty('dkgHome');
    expect(s.paths).toHaveProperty('dkgHomeEnv');
    expect(s.paths).toHaveProperty('activeSlot');
    expect(s.paths).toHaveProperty('npmGlobalDkg');
    expect(s.paths).toHaveProperty('pluginsRoot');
    expect(s.paths.dkgHome).toBe('/test/.dkg');
    expect(s.paths.pluginsRoot).toBe('/test/.dkg/plugins');
    expect(s.paths.activeSlot).toBeNull(); // Edge has no slot

    // autoUpdate.* — 6 fields
    expect(s.autoUpdate).toHaveProperty('enabled');
    expect(s.autoUpdate).toHaveProperty('checkIntervalMinutes');
    expect(s.autoUpdate).toHaveProperty('allowPrerelease');
    expect(s.autoUpdate).toHaveProperty('source');
    expect(s.autoUpdate).toHaveProperty('lastCheck');
    expect(s.autoUpdate).toHaveProperty('lastError');

    // previousVersion — 1 field
    expect(s).toHaveProperty('previousVersion');
  });

  it('parses commit / installMode / buildTime / distTag from /api/status when reachable', async () => {
    const deps = makeDeps({
      apiStatus: {
        version: '10.0.0-rc.12',
        commit: 'abcd1234567890abcdef',
        commitShort: 'abcd1234',
        buildTime: '2026-05-27T10:00:00Z',
        distTag: 'next',
        installMode: 'npm-global',
      },
    });
    const s = await collectStateSummary(deps);
    expect(s.daemon.version).toBe('10.0.0-rc.12');
    expect(s.daemon.commit).toBe('abcd1234567890abcdef');
    expect(s.daemon.commitShort).toBe('abcd1234');
    expect(s.daemon.buildTime).toBe('2026-05-27T10:00:00Z');
    expect(s.daemon.distTag).toBe('next');
    expect(s.daemon.installMode).toBe('npm-global');
  });

  it('reports activeSlot for Core nodes', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'core' }),
        '/test/.dkg/releases/current': 'symlink:a',
      },
    });
    const s = await collectStateSummary(deps);
    expect(s.daemon.nodeRole).toBe('core');
    expect(s.paths.activeSlot).toBe('a');
  });

  it('exposes auto-update.lastCheck and lastError when present', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': '{}',
        '/test/.dkg/auto-update/last-check.json': JSON.stringify({ timestamp: '2026-05-27T09:00:00Z' }),
        '/test/.dkg/auto-update/last-error.json': 'fetch failed: ECONNRESET',
      },
    });
    const s = await collectStateSummary(deps);
    expect(s.autoUpdate.lastCheck).toBe('2026-05-27T09:00:00Z');
    expect(s.autoUpdate.lastError).toBe('fetch failed: ECONNRESET');
  });

  it('truncates last-error.json over 1 KB', async () => {
    const huge = 'x'.repeat(2048);
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': '{}',
        '/test/.dkg/auto-update/last-error.json': huge,
      },
    });
    const s = await collectStateSummary(deps);
    expect(s.autoUpdate.lastError).toMatch(/…\[truncated\]$/);
    expect(s.autoUpdate.lastError!.length).toBeLessThan(huge.length);
  });
});

// ---------------------------------------------------------------------------
// orphan-repos (§4.7.1)
// ---------------------------------------------------------------------------

describe('orphan-repos check (§4.7.1)', () => {
  it('flags a stray clone with OriginTrail/dkg origin as warning', async () => {
    const deps = makeDeps({
      fs: {
        '/test/Projects/dkg/.git/config': '[remote "origin"]\n  url = https://github.com/OriginTrail/dkg.git\n',
        '/test/Projects/dkg/package.json': JSON.stringify({ name: 'doesnt-matter' }),
      },
    });
    const findings = await runOrphanReposCheck(deps, await collectStateSummary(deps));
    expect(findings.length).toBeGreaterThan(0);
    const stray = findings.find((f) => f.subject === '/test/Projects/dkg');
    expect(stray).toBeDefined();
    expect(stray!.severity).toBe('warning');
    expect(stray!.advisory).toMatch(/Do not 'git pull'/);
  });

  it('flags a clone via package.json name match', async () => {
    const deps = makeDeps({
      fs: {
        '/test/repos/dkg/package.json': JSON.stringify({ name: '@origintrail-official/dkg', version: '10.0.0' }),
      },
    });
    const findings = await runOrphanReposCheck(deps, await collectStateSummary(deps));
    const m = findings.find((f) => f.subject === '/test/repos/dkg');
    expect(m).toBeDefined();
    expect(m!.severity).toBe('warning');
  });

  it('reports the active-daemon source tree as info rather than warning', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/daemon.pid': '4242',
        '/test/Projects/dkg/.git/config': '[remote "origin"]\n  url = https://github.com/OriginTrail/dkg.git\n',
        '/test/Projects/dkg/packages/cli/dist/cli.js': '// daemon code',
      },
      apiStatus: { version: '10.0.0-rc.12' },
    });
    const state = await collectStateSummary(deps);
    // Inject a daemon entryPoint that sits inside the clone — tests
    // production behaviour where the doctor finds its own running
    // tree and labels it as info.
    state.daemon.entryPoint = '/test/Projects/dkg/packages/cli/dist/cli.js';
    const findings = await runOrphanReposCheck(deps, state);
    const m = findings.find((f) => f.subject === '/test/Projects/dkg');
    expect(m).toBeDefined();
    expect(m!.severity).toBe('info');
  });

  it('skips ignored directories (node_modules, .npm, .cache)', async () => {
    const deps = makeDeps({
      fs: {
        // Stray DKG clone NESTED inside a node_modules tree → must be skipped.
        '/test/Projects/some-app/node_modules/dkg/.git/config':
          '[remote "origin"]\n  url = https://github.com/OriginTrail/dkg.git\n',
      },
    });
    const findings = await runOrphanReposCheck(deps, await collectStateSummary(deps));
    expect(findings.find((f) => f.subject?.includes('node_modules'))).toBeUndefined();
  });

  it('respects .dkg-ignore-by-doctor sentinel', async () => {
    const deps = makeDeps({
      fs: {
        '/test/some/.dkg-ignore-by-doctor': '',
        '/test/some/.git/config': '[remote "origin"]\n  url = https://github.com/OriginTrail/dkg.git\n',
      },
    });
    const findings = await runOrphanReposCheck(deps, await collectStateSummary(deps));
    expect(findings.find((f) => f.subject === '/test/some')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// config-sanity (§4.7.2)
// ---------------------------------------------------------------------------

describe('config-sanity check (§4.7.2)', () => {
  it('flags missing config as warning, not error', async () => {
    const deps = makeDeps({ fs: {} });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.severity === 'warning')).toBeDefined();
  });

  it('flags malformed JSON as error', async () => {
    const deps = makeDeps({
      fs: { '/test/.dkg/config.json': '{ not json' },
    });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.severity === 'error')).toBeDefined();
  });

  it('rejects invalid nodeRole values', async () => {
    const deps = makeDeps({
      fs: { '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'lighthouse' }) },
    });
    const findings = await runConfigSanityCheck(deps);
    const e = findings.find((f) => f.subject === 'nodeRole');
    expect(e).toBeDefined();
    expect(e!.severity).toBe('error');
  });

  it('rejects out-of-range apiPort', async () => {
    const deps = makeDeps({
      fs: { '/test/.dkg/config.json': JSON.stringify({ apiPort: 70000 }) },
    });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.subject === 'apiPort' && f.severity === 'error')).toBeDefined();
  });

  it('warns on deprecated autoUpdate fields set to non-empty values', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({
          autoUpdate: {
            source: 'npm',
            repo: 'https://github.com/OriginTrail/dkg.git',
            branch: 'main',
            ref: 'refs/heads/canary',
            sshKeyPath: '/tmp/git-key',
            sshCommand: 'ssh -i /tmp/git-key',
            buildTimeoutMs: { install: 600000 },
          },
        }),
      },
    });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.subject === 'autoUpdate.repo')).toBeDefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.branch')).toBeDefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.ref')).toBeDefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.sshKeyPath')).toBeDefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.sshCommand')).toBeDefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.buildTimeoutMs')).toBeDefined();
  });

  it('does not warn on git updater fields when autoUpdate.source is git', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({
          autoUpdate: {
            source: 'git',
            repo: 'https://github.com/OriginTrail/dkg.git',
            branch: 'main',
            ref: 'refs/heads/canary',
            sshKeyPath: '/tmp/git-key',
            sshCommand: 'ssh -i /tmp/git-key',
            buildTimeoutMs: { install: 600000 },
          },
        }),
      },
    });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.subject === 'autoUpdate.repo')).toBeUndefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.branch')).toBeUndefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.ref')).toBeUndefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.sshKeyPath')).toBeUndefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.sshCommand')).toBeUndefined();
    expect(findings.find((f) => f.subject === 'autoUpdate.buildTimeoutMs')).toBeUndefined();
  });

  it('warns when git tag-signature verification is enabled for a branch ref', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({
          autoUpdate: {
            source: 'git',
            repo: 'https://github.com/OriginTrail/dkg.git',
            branch: 'main',
            verifyTagSignature: true,
          },
        }),
      },
    });
    const findings = await runConfigSanityCheck(deps);
    const warning = findings.find((f) => f.subject === 'autoUpdate.verifyTagSignature');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('warning');
    expect(warning!.message).toContain('refs/heads/main');
  });

  it('does not warn when git tag-signature verification targets a tag ref', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({
          autoUpdate: {
            source: 'git',
            repo: 'https://github.com/OriginTrail/dkg.git',
            ref: 'refs/tags/v10.0.8',
            verifyTagSignature: true,
          },
        }),
      },
    });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.subject === 'autoUpdate.verifyTagSignature')).toBeUndefined();
  });

  it('does not warn for non-boolean persisted tag-signature values', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({
          autoUpdate: {
            source: 'git',
            repo: 'https://github.com/OriginTrail/dkg.git',
            branch: 'main',
            verifyTagSignature: 'false',
          },
        }),
      },
    });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.subject === 'autoUpdate.verifyTagSignature')).toBeUndefined();
  });

  it('errors on checkIntervalMinutes < 1', async () => {
    const deps = makeDeps({
      fs: { '/test/.dkg/config.json': JSON.stringify({ autoUpdate: { checkIntervalMinutes: 0 } }) },
    });
    const findings = await runConfigSanityCheck(deps);
    expect(findings.find((f) => f.subject === 'autoUpdate.checkIntervalMinutes' && f.severity === 'error')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// install-layout (§4.7.3)
// ---------------------------------------------------------------------------

describe('install-layout check (§4.7.3)', () => {
  it('Edge: advises deleting releases/ when the daemon is proven to run from outside it', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
        '/test/.dkg/releases/a/dist/cli.js': '// stale slot',
      },
    });
    const state = await collectStateSummary(deps);
    // Daemon resolved to the npm-global install, i.e. positively outside releases/.
    state.daemon.entryPoint = '/usr/local/lib/node_modules/@origintrail-official/dkg/dist/cli.js';
    const findings = await runInstallLayoutCheck(deps, state);
    const m = findings.find((f) => f.subject === '/test/.dkg/releases');
    expect(m).toBeDefined();
    expect(m!.severity).toBe('warning');
    expect(m!.advisory).toMatch(/Safe to delete/);
    expect(m!.advisory).toMatch(/rm -rf \/test\/\.dkg\/releases/);
  });

  it('Edge: does NOT promise "Safe to delete" releases/ when the daemon entry point is unknown (e.g. win32)', async () => {
    // #750 follow-up: collectStateSummary() can return a null entryPoint
    // (notably on win32). We must not fall back to the unconditional
    // "Safe to delete" advisory there, because we cannot prove the daemon
    // isn't running from the releases tree.
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
        '/test/.dkg/releases/a/dist/cli.js': '// possibly live slot',
      },
    });
    const state = await collectStateSummary(deps);
    state.daemon.entryPoint = null;
    const findings = await runInstallLayoutCheck(deps, state);
    const m = findings.find((f) => f.subject === '/test/.dkg/releases');
    expect(m).toBeDefined();
    expect(m!.advisory).not.toMatch(/Safe to delete/);
    expect(m!.advisory).toMatch(/could not be resolved|Verify/);
    expect(m!.message).toMatch(/could not resolve/);
  });

  it('Edge: does NOT advise deleting releases/ while the daemon is running from it', async () => {
    // #750 follow-up: an upgraded Edge node can still be running from
    // ~/.dkg/releases/current until restart. The advisory must not tell
    // the operator to delete the live runtime.
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
        '/test/.dkg/releases/a/packages/cli/dist/cli.js': '// live slot',
      },
    });
    const state = await collectStateSummary(deps);
    state.daemon.entryPoint = '/test/.dkg/releases/a/packages/cli/dist/cli.js';
    const findings = await runInstallLayoutCheck(deps, state);
    const m = findings.find((f) => f.subject === '/test/.dkg/releases');
    expect(m).toBeDefined();
    expect(m!.advisory).not.toMatch(/Safe to delete/);
    expect(m!.advisory).toMatch(/Do NOT delete/);
    expect(m!.message).toMatch(/still running from a legacy slot/);
  });

  it('Edge: warns when daemon entryPoint is outside the npm-global install', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
      },
    });
    const state = await collectStateSummary(deps);
    // Force npmGlobalDkg + entryPoint to specific paths for the assertion.
    state.paths.npmGlobalDkg = '/usr/local/lib/node_modules/@origintrail-official/dkg';
    state.daemon.entryPoint = '/Users/someone/random-clone/packages/cli/dist/cli.js';
    const findings = await runInstallLayoutCheck(deps, state);
    expect(findings.find((f) => f.message.includes('not inside the npm-global install'))).toBeDefined();
  });

  it('Edge: warns when daemon entryPoint only shares the npm-global path prefix', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
      },
    });
    const state = await collectStateSummary(deps);
    state.paths.npmGlobalDkg = '/usr/local/lib/node_modules/@origintrail-official/dkg';
    state.daemon.entryPoint = '/usr/local/lib/node_modules/@origintrail-official/dkg-old/dist/cli.js';
    const findings = await runInstallLayoutCheck(deps, state);
    expect(findings.find((f) => f.message.includes('not inside the npm-global install'))).toBeDefined();
  });

  it('Core: errors on missing current symlink', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'core' }),
      },
    });
    const state = await collectStateSummary(deps);
    const findings = await runInstallLayoutCheck(deps, state);
    expect(findings.find((f) => f.severity === 'error' && f.message.includes("missing blue-green 'current'"))).toBeDefined();
  });

  it('Core: warns on partial inactive slot (files but no entry point)', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'core' }),
        '/test/.dkg/releases/current': 'symlink:a',
        '/test/.dkg/releases/a/packages/cli/dist/cli.js': '// active slot',
        // slot b populated but no entry point
        '/test/.dkg/releases/b/half-written-file': 'oops',
      },
    });
    const state = await collectStateSummary(deps);
    const findings = await runInstallLayoutCheck(deps, state);
    expect(findings.find((f) => f.message.includes("Inactive slot 'b'") && f.severity === 'warning')).toBeDefined();
  });

  it('Core: warns on legacy .git inside a slot', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'core' }),
        '/test/.dkg/releases/current': 'symlink:a',
        '/test/.dkg/releases/a/packages/cli/dist/cli.js': '// active slot',
        '/test/.dkg/releases/a/.git/config': '[remote "origin"]',
      },
    });
    const state = await collectStateSummary(deps);
    const findings = await runInstallLayoutCheck(deps, state);
    expect(findings.find((f) => f.message.includes("Legacy '.git' directory") && f.severity === 'warning')).toBeDefined();
  });

  it('Core: allows .git inside slots when git updater mode is configured', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({
          nodeRole: 'core',
          autoUpdate: { enabled: true, source: 'git' },
        }),
        '/test/.dkg/releases/current': 'symlink:a',
        '/test/.dkg/releases/a/packages/cli/dist/cli.js': '// active slot',
        '/test/.dkg/releases/a/.git/config': '[remote "origin"]',
      },
    });
    const state = await collectStateSummary(deps);
    const findings = await runInstallLayoutCheck(deps, state);
    expect(findings.find((f) => f.message.includes("Legacy '.git' directory"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// version-skew (§4.7.4)
// ---------------------------------------------------------------------------

describe('version-skew check (§4.7.4)', () => {
  // NOTE: the version-skew check's `semverCompare` strips pre-release
  // suffixes (`-rc.N`) before comparing, so to actually exercise the
  // ordering branch we use major.minor.patch deltas in these tests.
  // The string-equality early-return is exercised separately below.
  it('Edge: warns when npm-global is ahead of running daemon', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
        '/usr/local/lib/node_modules/@origintrail-official/dkg/package.json':
          JSON.stringify({ version: '10.1.0' }),
      },
      apiStatus: { version: '10.0.0' },
    });
    const state = await collectStateSummary(deps);
    state.paths.npmGlobalDkg = '/usr/local/lib/node_modules/@origintrail-official/dkg';
    const findings = await runVersionSkewCheck(deps, state);
    expect(findings.find((f) => f.message.includes('npm-global install is ahead'))).toBeDefined();
  });

  it('Edge: warns when daemon is ahead of npm-global install', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
        '/usr/local/lib/node_modules/@origintrail-official/dkg/package.json':
          JSON.stringify({ version: '9.5.0' }),
      },
      apiStatus: { version: '10.0.0' },
    });
    const state = await collectStateSummary(deps);
    state.paths.npmGlobalDkg = '/usr/local/lib/node_modules/@origintrail-official/dkg';
    const findings = await runVersionSkewCheck(deps, state);
    expect(findings.find((f) => f.message.includes('Running daemon is ahead'))).toBeDefined();
  });

  it('Core: warns on slot-vs-daemon mismatch', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'core' }),
        '/test/.dkg/releases/current': 'symlink:a',
        '/test/.dkg/releases/a/node_modules/@origintrail-official/dkg/package.json':
          JSON.stringify({ version: '10.0.0-rc.13' }),
      },
      apiStatus: { version: '10.0.0-rc.12' },
    });
    const state = await collectStateSummary(deps);
    const findings = await runVersionSkewCheck(deps, state);
    expect(findings.find((f) => f.message.includes('Core slot version'))).toBeDefined();
  });

  it('Edge: no finding when versions match exactly', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
        '/usr/local/lib/node_modules/@origintrail-official/dkg/package.json':
          JSON.stringify({ version: '10.0.0-rc.12' }),
      },
      apiStatus: { version: '10.0.0-rc.12' },
    });
    const state = await collectStateSummary(deps);
    state.paths.npmGlobalDkg = '/usr/local/lib/node_modules/@origintrail-official/dkg';
    const findings = await runVersionSkewCheck(deps, state);
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// served-ui-mismatch (§4.7.5)
// ---------------------------------------------------------------------------

describe('served-ui-mismatch check (§4.7.5)', () => {
  it('skips with info when daemon is unreachable', async () => {
    const deps = makeDeps({});
    const state = await collectStateSummary(deps);
    const findings = await runServedUiMismatchCheck(deps, state);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].message).toMatch(/daemon unreachable/);
  });

  it('warns when <meta name=version> on served HTML disagrees with installed UI', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge' }),
        '/usr/local/lib/node_modules/@origintrail-official/dkg/node_modules/@origintrail-official/dkg-node-ui/package.json':
          JSON.stringify({ version: '10.0.0-rc.12' }),
      },
      apiStatus: { version: '10.0.0-rc.12' },
      uiHtml: '<!doctype html><html><head><meta name="version" content="10.0.0-rc.10"></head></html>',
    });
    const state = await collectStateSummary(deps);
    state.paths.npmGlobalDkg = '/usr/local/lib/node_modules/@origintrail-official/dkg';
    const findings = await runServedUiMismatchCheck(deps, state);
    const w = findings.find((f) => f.severity === 'warning');
    expect(w).toBeDefined();
    expect(w!.message).toMatch(/does not match installed/);
  });
});

// ---------------------------------------------------------------------------
// plugin-root (§4.7.6)
// ---------------------------------------------------------------------------

describe('plugin-root check (§4.7.6)', () => {
  it('info when stable plugin root is missing', async () => {
    const deps = makeDeps({
      fs: { '/test/.dkg/config.json': '{}' },
    });
    const findings = await runPluginRootCheck(deps);
    expect(findings.find((f) => f.severity === 'info' && f.message.includes('plugin install root not yet'))).toBeDefined();
  });

  it('warns on bare-name plugin not installed under plugins/node_modules', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ routePlugins: ['@some/dkg-route-plugin'] }),
        '/test/.dkg/plugins/package.json': JSON.stringify({ name: 'dkg-plugin-root', private: true }),
      },
    });
    const findings = await runPluginRootCheck(deps);
    const w = findings.find((f) => f.severity === 'warning' && f.subject === '@some/dkg-route-plugin');
    expect(w).toBeDefined();
    expect(w!.advisory).toMatch(/npm install --prefix .*\.dkg\/plugins/);
  });

  it('errors on absolute path that does not exist', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ routePlugins: ['/absent/plugin.js'] }),
      },
    });
    const findings = await runPluginRootCheck(deps);
    expect(findings.find((f) => f.severity === 'error' && f.subject === '/absent/plugin.js')).toBeDefined();
  });

  it('does not flag bare-name plugin installed under plugins/node_modules', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ routePlugins: ['@some/dkg-route-plugin'] }),
        '/test/.dkg/plugins/package.json': JSON.stringify({ name: 'dkg-plugin-root', private: true }),
        '/test/.dkg/plugins/node_modules/@some/dkg-route-plugin/package.json':
          JSON.stringify({ name: '@some/dkg-route-plugin' }),
      },
    });
    const findings = await runPluginRootCheck(deps);
    expect(findings.find((f) => f.subject === '@some/dkg-route-plugin')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// orchestrator integration
// ---------------------------------------------------------------------------

describe('runDoctor orchestrator', () => {
  it('returns exitCode 0 when no anomalies and only info findings', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'edge', autoUpdate: { source: 'npm' } }),
      },
    });
    const report = await runDoctor(deps, { checks: ['config-sanity'] });
    expect(report.exitCode).toBe(0);
  });

  it('returns exitCode 1 when there are warnings but no errors', async () => {
    const deps = makeDeps({
      fs: {
        '/test/.dkg/config.json': JSON.stringify({
          nodeRole: 'edge',
          autoUpdate: { repo: 'https://x' }, // deprecated → warning
        }),
      },
    });
    const report = await runDoctor(deps, { checks: ['config-sanity'] });
    expect(report.exitCode).toBe(1);
  });

  it('returns exitCode 2 when at least one finding is severity:error', async () => {
    const deps = makeDeps({
      fs: { '/test/.dkg/config.json': '{ not json' },
    });
    const report = await runDoctor(deps, { checks: ['config-sanity'] });
    expect(report.exitCode).toBe(2);
  });

  it('honours skipChecks', async () => {
    const deps = makeDeps({
      skipChecks: ['orphan-repos'],
      fs: { '/test/.dkg/config.json': '{}' },
    });
    const report = await runDoctor(deps);
    expect(report.findings.find((f) => f.check === 'orphan-repos')).toBeUndefined();
  });

  it('schema version is stable at 1', async () => {
    const deps = makeDeps({});
    const report = await runDoctor(deps, { checks: [] });
    expect(report.schemaVersion).toBe(1);
  });

  it('always-on state summary populates even when all checks skipped', async () => {
    const deps = makeDeps({
      skipChecks: [...ALL_CHECK_IDS],
      fs: { '/test/.dkg/config.json': JSON.stringify({ nodeRole: 'core' }) },
    });
    const report = await runDoctor(deps);
    expect(report.findings).toEqual([]);
    expect(report.state.daemon.nodeRole).toBe('core');
    expect(report.state.paths.dkgHome).toBe('/test/.dkg');
  });
});
