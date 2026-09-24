import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAutoUpdateConfig } from '../src/config.js';
import { _autoUpdateIo } from '../src/daemon/manifest.js';
import { UPDATE_JITTER_ENV, type UpdateHoldoffRecord } from '../src/daemon/auto-update-jitter.js';
import { parseUpdateHoldoffRecord, UPDATE_HOLDOFF_FILE } from '../src/daemon/auto-update-holdoff-store.js';
import {
  createDaemonUpdateHoldoffGate,
  startDaemonUpdatePolling,
  startGitUpdatePolling,
  startNpmUpdatePolling,
  type DaemonUpdatePollingDeps,
  type UpdatePollingTimers,
} from '../src/daemon/auto-update-polling.js';

const GIT_AU = {
  enabled: true,
  repo: 'git@github.com:owner/repo.git',
  branch: 'main',
  sshKeyPath: '/tmp/key',
  checkIntervalMinutes: 3,
  updateJitterMinutes: 30,
  allowPrerelease: false,
} as ResolvedAutoUpdateConfig;

async function readRecord(home: string): Promise<UpdateHoldoffRecord | null> {
  try {
    return parseUpdateHoldoffRecord(await readFile(join(home, UPDATE_HOLDOFF_FILE), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

let home = '';
beforeEach(async () => {
  vi.stubEnv(UPDATE_JITTER_ENV, undefined);
  home = await mkdtemp(join(tmpdir(), 'dkg-home-polling-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('createDaemonUpdateHoldoffGate', () => {
  it('keeps the deadline in <DKG home>/.update-holdoff.json, so the next boot resumes it', async () => {
    const clock = { t: 1_790_000_000_000 };
    function boot(rng: () => number, killAfterMs?: number) {
      let shuttingDown = false;
      const sleeps: number[] = [];
      const gate = createDaemonUpdateHoldoffGate(
        { au: GIT_AU, dkgHome: home, isShuttingDown: () => shuttingDown, setUpdating: () => {}, log: () => {} },
        {
          rng,
          now: () => clock.t,
          sleep: async (ms) => {
            sleeps.push(ms);
            if (killAfterMs !== undefined && ms > killAfterMs) {
              clock.t += killAfterMs;
              shuttingDown = true;
              return;
            }
            clock.t += ms;
          },
        },
      );
      const apply = vi.fn(async (_target: string) => {});
      const run = () => gate.poll({ status: 'available', target: 'c1' }, {
        onHold: () => {},
        revalidate: async () => ({ status: 'available', target: 'c1' }),
        apply,
        shutdownMessage: 'SHUTDOWN',
        supersededMessage: 'SUPERSEDED',
        recheckFailedMessage: 'RECHECK_FAILED',
      });
      return { run, apply, sleeps };
    }

    const detectedAt = clock.t;
    const first = boot(() => 0.5, 6 * 60_000);
    await first.run();
    expect(first.apply).not.toHaveBeenCalled();
    expect(await readRecord(home)).toEqual({ target: 'c1', deadlineEpochMs: detectedAt + 900_000 });

    const rng = vi.fn(() => 0.99);
    const second = boot(rng);
    await second.run();
    expect(rng).not.toHaveBeenCalled();
    expect(second.sleeps).toEqual([540_000]);
    expect(second.apply).toHaveBeenCalledWith('c1');
    expect(await readdir(home)).toEqual([]);
  });
});

// The scheduled runChecks run the real git/npm checks. Only the check-level
// I/O is stubbed; the hold-off record goes to a real temporary DKG home.
describe('startGitUpdatePolling / startNpmUpdatePolling', () => {
  function stubChecks() {
    const realReadFile = _autoUpdateIo.readFile;
    vi.spyOn(_autoUpdateIo, 'readFile').mockImplementation((async (path: any, ...rest: any[]) => {
      if (String(path).endsWith('.current-commit')) return 'aaa1111';
      if (String(path).endsWith('.current-version')) return '9.0.0';
      return (realReadFile as any)(path, ...rest);
    }) as any);
    vi.spyOn(_autoUpdateIo, 'execFile').mockImplementation((async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'ls-remote') return { stdout: 'bbb2222\trefs/heads/main\n', stderr: '' };
      throw new Error(`unexpected execFile ${file} ${args.join(' ')}`);
    }) as any);
    vi.spyOn(_autoUpdateIo, 'fetch').mockImplementation((async () =>
      ({ ok: true, json: async () => ({ 'dist-tags': { latest: '9.1.0' } }) })) as any);
  }

  function pollingHarness() {
    const scheduled: Array<{ kind: 'timeout' | 'interval'; ms: number; fn: () => unknown }> = [];
    const timers: UpdatePollingTimers = {
      setTimeout: (fn, ms) => { scheduled.push({ kind: 'timeout', ms, fn }); return undefined; },
      setInterval: (fn, ms) => { scheduled.push({ kind: 'interval', ms, fn }); return undefined as any; },
    };
    let shuttingDown = false;
    const deps: DaemonUpdatePollingDeps = {
      dkgHome: home,
      isShuttingDown: () => shuttingDown,
      setUpdating: () => {},
      log: () => {},
      lastUpdateCheck: { upToDate: false, checkedAt: 0, latestCommit: '', latestVersion: '', channelTargetMissing: false },
      onRestart: async () => {},
      timers,
      // The hold ends in a restart, so a tick persists its deadline and stops.
      gateSeams: { rng: () => 0.5, now: () => 1_000, sleep: async () => { shuttingDown = true; } },
    };
    return { scheduled, deps };
  }

  beforeEach(() => { stubChecks(); });

  it('git: both scheduled checks share one gate that persists the deadline under the DKG home', async () => {
    const { scheduled, deps } = pollingHarness();

    startGitUpdatePolling(GIT_AU, deps);
    expect(scheduled.map(({ kind, ms }) => [kind, ms])).toEqual([['timeout', 15_000], ['interval', 3 * 60_000]]);
    expect(scheduled[0].fn, 'one runCheck (one gate) for both timers').toBe(scheduled[1].fn);

    await scheduled[0].fn();
    expect(await readRecord(home)).toEqual({ target: 'bbb2222', deadlineEpochMs: 1_000 + 900_000 });
  });

  it('npm: both scheduled checks share one gate that persists the deadline under the DKG home', async () => {
    const { scheduled, deps } = pollingHarness();

    startNpmUpdatePolling({ au: GIT_AU, checkIntervalMinutes: 3, allowPrerelease: false, nodeRole: 'core' }, deps);
    expect(scheduled.map(({ kind, ms }) => [kind, ms])).toEqual([['timeout', 15_000], ['interval', 3 * 60_000]]);
    expect(scheduled[0].fn).toBe(scheduled[1].fn);

    await scheduled[0].fn();
    expect(await readRecord(home)).toEqual({ target: '9.1.0', deadlineEpochMs: 1_000 + 900_000 });
  });

  it('npm with auto-apply disabled: checks and records the version, but has no gate and writes no deadline', async () => {
    const { scheduled, deps } = pollingHarness();

    startNpmUpdatePolling({ au: null, checkIntervalMinutes: 30, allowPrerelease: false, nodeRole: 'core' }, deps);
    expect(scheduled.map(({ kind, ms }) => [kind, ms])).toEqual([['timeout', 15_000], ['interval', 30 * 60_000]]);

    await scheduled[0].fn();
    expect(deps.lastUpdateCheck.latestVersion).toBe('9.1.0');
    expect(await readdir(home)).toEqual([]);
  });
});

// The lifecycle-to-polling boundary: which mode starts, with which inputs.
describe('startDaemonUpdatePolling', () => {
  function harness() {
    const logs: string[] = [];
    const handle = setInterval(() => {}, 60_000);
    clearInterval(handle);
    const starters = {
      git: vi.fn((_au: ResolvedAutoUpdateConfig, _deps: DaemonUpdatePollingDeps) => handle),
      npm: vi.fn((_opts: Parameters<typeof startNpmUpdatePolling>[0], _deps: DaemonUpdatePollingDeps) => handle),
    };
    const deps: DaemonUpdatePollingDeps = {
      dkgHome: home,
      isShuttingDown: () => false,
      setUpdating: () => {},
      log: (m) => logs.push(m),
      lastUpdateCheck: { upToDate: false, checkedAt: 0, latestCommit: '', latestVersion: '', channelTargetMissing: false },
      onRestart: async () => {},
    };
    return { logs, handle, starters, deps };
  }

  it('git mode: starts git polling with the daemon deps and returns its interval', () => {
    const { logs, handle, starters, deps } = harness();
    const result = startDaemonUpdatePolling({ pollingMode: 'git', au: GIT_AU, nodeRole: 'core' }, deps, starters);
    expect(result).toBe(handle);
    expect(starters.git).toHaveBeenCalledWith(GIT_AU, deps);
    expect(starters.git.mock.calls[0][1].dkgHome).toBe(home);
    expect(starters.npm).not.toHaveBeenCalled();
    expect(logs.some((m) => m.startsWith('Auto-update (git): enabled source="git"'))).toBe(true);
  });

  it('git mode with auto-update disabled, or an invalid repo: logs and starts nothing', () => {
    const { logs, starters, deps } = harness();
    expect(startDaemonUpdatePolling({ pollingMode: 'git', au: null, nodeRole: 'core' }, deps, starters)).toBeNull();
    expect(logs).toContain('Auto-update (git): disabled — autoUpdate.enabled is false.');

    const badRepo = { ...GIT_AU, repo: 'not a repo spec' } as ResolvedAutoUpdateConfig;
    expect(startDaemonUpdatePolling({ pollingMode: 'git', au: badRepo, nodeRole: 'core' }, deps, starters)).toBeNull();
    expect(logs.some((m) => m.startsWith('Auto-update (git): invalid config'))).toBe(true);
    expect(starters.git).not.toHaveBeenCalled();
    expect(starters.npm).not.toHaveBeenCalled();
  });

  it('npm mode with auto-apply: starts npm polling with the resolved config and its policy', () => {
    const { handle, starters, deps } = harness();
    const au = { ...GIT_AU, channel: 'beta', allowPrerelease: true } as ResolvedAutoUpdateConfig;
    const result = startDaemonUpdatePolling(
      { pollingMode: 'npm', au, localAutoUpdate: { channel: 'ignored' }, nodeRole: 'core' },
      deps,
      starters,
    );
    expect(result).toBe(handle);
    expect(starters.npm).toHaveBeenCalledWith(
      { au, checkIntervalMinutes: 3, allowPrerelease: true, channel: 'beta', nodeRole: 'core' },
      deps,
    );
    expect(starters.git).not.toHaveBeenCalled();
  });

  it('npm mode, version check only: starts npm polling without a config, local policy before network', () => {
    const { logs, handle, starters, deps } = harness();
    const result = startDaemonUpdatePolling(
      {
        pollingMode: 'npm',
        au: null,
        localAutoUpdate: { channel: 'beta' },
        networkAutoUpdate: { channel: 'latest', allowPrerelease: false },
        nodeRole: 'edge',
      },
      deps,
      starters,
    );
    expect(result).toBe(handle);
    expect(starters.npm).toHaveBeenCalledWith(
      { au: null, checkIntervalMinutes: 30, allowPrerelease: false, channel: 'beta', nodeRole: 'edge' },
      deps,
    );
    expect(logs).toContain('Auto-update (npm): disabled — version check only channel="beta" (every 30min)');
  });

  it('monorepo: starts nothing, and says so when auto-update is enabled', () => {
    const { logs, starters, deps } = harness();
    expect(startDaemonUpdatePolling({ pollingMode: 'monorepo', au: null, nodeRole: 'core' }, deps, starters)).toBeNull();
    expect(logs).toEqual([]);
    expect(startDaemonUpdatePolling({ pollingMode: 'monorepo', au: GIT_AU, nodeRole: 'core' }, deps, starters)).toBeNull();
    expect(logs.some((m) => m.startsWith('Auto-update: skipped — monorepo checkout detected'))).toBe(true);
    expect(starters.git).not.toHaveBeenCalled();
    expect(starters.npm).not.toHaveBeenCalled();
  });
});
