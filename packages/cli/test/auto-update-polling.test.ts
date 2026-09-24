import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The installers are replaced (the checks stay real): a test sees which one an
// apply reaches, and nothing is built or installed.
const installers = vi.hoisted(() => ({
  npmCore: vi.fn(async (..._args: unknown[]) => 'failed' as const),
  npmEdge: vi.fn(async (..._args: unknown[]) => 'failed' as const),
}));
vi.mock('../src/daemon/auto-update.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/auto-update.js')>()),
  performNpmUpdate: installers.npmCore,
  performNpmUpdateEdge: installers.npmEdge,
}));
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAutoUpdateConfig } from '../src/config.js';
import { _autoUpdateIo } from '../src/daemon/manifest.js';
import { UPDATE_JITTER_ENV } from '../src/daemon/auto-update-jitter.js';
import type { UpdateHoldoffRecord } from '../src/daemon/auto-update-holdoff-deadline.js';
import { DAEMON_EXIT_CODE_RESTART } from '../src/daemon/manifest.js';
import { daemonState } from '../src/daemon/state.js';
import { parseUpdateHoldoffRecord, UPDATE_HOLDOFF_FILE } from '../src/daemon/auto-update-holdoff-store.js';
import {
  createDaemonUpdateHoldoffGate,
  resolveDaemonUpdateMode,
  startDaemonAutoUpdate,
  startDaemonUpdatePolling,
  startGitUpdatePolling,
  startNpmUpdatePolling,
  type DaemonUpdateMode,
  type DaemonUpdatePollingDeps,
  type UpdatePolling,
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
  daemonState.standaloneCache = null;
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
      const poll = gate.bindRollout<string>({
        onHold: () => {},
        revalidate: async () => ({ status: 'available', target: 'c1' }),
        apply,
        shutdownMessage: 'SHUTDOWN',
        supersededMessage: 'SUPERSEDED',
        recheckFailedMessage: 'RECHECK_FAILED',
      });
      const run = () => poll({ status: 'available', target: 'c1' });
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
    const cleared: unknown[] = [];
    const timers: UpdatePollingTimers = {
      setTimeout: (fn, ms) => { scheduled.push({ kind: 'timeout', ms, fn }); return 'startup-timer'; },
      clearTimeout: (handle) => { cleared.push(handle); },
      setInterval: (fn, ms) => { scheduled.push({ kind: 'interval', ms, fn }); return 'interval-timer'; },
      clearInterval: (handle) => { cleared.push(handle); },
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
    return { scheduled, cleared, deps };
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

  it('npm auto-apply: interval and policy come from the config; both checks share one persisted gate', async () => {
    const { scheduled, deps } = pollingHarness();

    startNpmUpdatePolling({ mode: 'npm-auto-apply', au: GIT_AU, nodeRole: 'core' }, deps);
    expect(scheduled.map(({ kind, ms }) => [kind, ms])).toEqual([['timeout', 15_000], ['interval', 3 * 60_000]]);
    expect(scheduled[0].fn).toBe(scheduled[1].fn);

    await scheduled[0].fn();
    expect(await readRecord(home)).toEqual({ target: '9.1.0', deadlineEpochMs: 1_000 + 900_000 });
  });

  it('npm with auto-apply disabled: checks and records the version, but has no gate and writes no deadline', async () => {
    const { scheduled, deps } = pollingHarness();

    startNpmUpdatePolling({ mode: 'npm-check-only', policy: { allowPrerelease: false } }, deps);
    expect(scheduled.map(({ kind, ms }) => [kind, ms])).toEqual([['timeout', 15_000], ['interval', 30 * 60_000]]);

    await scheduled[0].fn();
    expect(deps.lastUpdateCheck.latestVersion).toBe('9.1.0');
    expect(await readdir(home)).toEqual([]);
  });

  it('npm auto-apply with no node role configured installs through the edge (global npm) installer', async () => {
    installers.npmCore.mockClear();
    installers.npmEdge.mockClear();
    const { scheduled, deps } = pollingHarness();
    const mode = resolveDaemonUpdateMode(
      { autoUpdate: { enabled: true, source: 'npm', repo: GIT_AU.repo, branch: 'main', checkIntervalMinutes: 3 } } as any,
      null,
    );
    expect(mode).toMatchObject({ mode: 'npm-auto-apply', nodeRole: 'edge' });

    startDaemonUpdatePolling(mode, { ...deps, gateSeams: { rng: () => 0.5, now: () => 1_000, sleep: async () => {} } });
    await scheduled[0].fn();
    expect(installers.npmEdge).toHaveBeenCalledOnce();
    expect(installers.npmEdge.mock.calls[0][0]).toBe('9.1.0');
    expect(installers.npmCore).not.toHaveBeenCalled();
  });

  it('stop() before the first check cancels it: no check runs and no deadline is written', async () => {
    const { deps } = pollingHarness();
    vi.useFakeTimers();
    try {
      const polling = startGitUpdatePolling(GIT_AU, { ...deps, timers: undefined }); // the real (faked) timers
      vi.advanceTimersByTime(10_000);
      polling.stop(); // shutdown began 10 s after boot
      vi.advanceTimersByTime(60 * 60_000);
    } finally {
      vi.useRealTimers();
    }
    expect(_autoUpdateIo.execFile).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it('stop() clears both timers, and a tick that was already queued does nothing', async () => {
    const { scheduled, cleared, deps } = pollingHarness();
    const polling = startGitUpdatePolling(GIT_AU, deps);
    polling.stop();
    expect(cleared).toEqual(['startup-timer', 'interval-timer']);

    await scheduled[0].fn();
    expect(_autoUpdateIo.execFile).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });
});

// The lifecycle-to-polling boundary: the daemon's startup states, how each one
// dispatches, and the handoff that resolves them from the daemon's config.
describe('startDaemonUpdatePolling', () => {
  const NPM_AU = { ...GIT_AU, channel: 'beta' } as ResolvedAutoUpdateConfig;
  const BAD_REPO_AU = { ...GIT_AU, repo: 'not a repo spec' } as ResolvedAutoUpdateConfig;

  function harness() {
    const logs: string[] = [];
    const polling: UpdatePolling = { stop: vi.fn() };
    const starters = {
      git: vi.fn((_au: ResolvedAutoUpdateConfig, _deps: DaemonUpdatePollingDeps) => polling),
      npm: vi.fn((_opts: Parameters<typeof startNpmUpdatePolling>[0], _deps: DaemonUpdatePollingDeps) => polling),
    };
    const deps: DaemonUpdatePollingDeps = {
      dkgHome: home,
      isShuttingDown: () => false,
      setUpdating: () => {},
      log: (m) => logs.push(m),
      lastUpdateCheck: { upToDate: false, checkedAt: 0, latestCommit: '', latestVersion: '', channelTargetMissing: false },
      onRestart: async () => {},
    };
    return { logs, polling, starters, deps };
  }

  // Every DaemonUpdateMode variant: which starter runs (with what), what is logged.
  const cases: Array<{
    name: string;
    state: DaemonUpdateMode;
    starter: 'git' | 'npm' | null;
    starterArg?: unknown;
    log: string | null;
  }> = [
    { name: 'git', state: { mode: 'git', au: GIT_AU }, starter: 'git', starterArg: GIT_AU,
      log: 'Auto-update (git): enabled source="git"; watching repo="git@github.com:owner/repo.git" ref="refs/heads/main"' },
    { name: 'git with an invalid repo', state: { mode: 'git', au: BAD_REPO_AU }, starter: null,
      log: 'Auto-update (git): invalid config' },
    { name: 'git-disabled', state: { mode: 'git-disabled' }, starter: null,
      log: 'Auto-update (git): disabled — autoUpdate.enabled is false.' },
    { name: 'npm-auto-apply', state: { mode: 'npm-auto-apply', au: NPM_AU, nodeRole: 'core' }, starter: 'npm',
      starterArg: { mode: 'npm-auto-apply', au: NPM_AU, nodeRole: 'core' },
      log: 'Auto-update (npm): enabled channel="beta" (every 3min)' },
    { name: 'npm-check-only', state: { mode: 'npm-check-only', policy: { allowPrerelease: false, channel: 'beta' } }, starter: 'npm',
      starterArg: { mode: 'npm-check-only', policy: { allowPrerelease: false, channel: 'beta' } },
      log: 'Auto-update (npm): disabled — version check only channel="beta" (every 30min)' },
    { name: 'monorepo with auto-update enabled', state: { mode: 'monorepo', autoUpdateEnabled: true }, starter: null,
      log: 'Auto-update: skipped — monorepo checkout detected' },
    { name: 'monorepo', state: { mode: 'monorepo', autoUpdateEnabled: false }, starter: null, log: null },
  ];

  it.each(cases)('$name', ({ state, starter, starterArg, log }) => {
    const { logs, polling, starters, deps } = harness();
    const result = startDaemonUpdatePolling(state, deps, starters);

    if (starter) {
      expect(result).toBe(polling);
      expect(starters[starter]).toHaveBeenCalledWith(starterArg, deps);
    } else {
      expect(result).toBeNull();
    }
    for (const name of ['git', 'npm'] as const) {
      if (name !== starter) expect(starters[name]).not.toHaveBeenCalled();
    }
    if (log) expect(logs.some((m) => m.startsWith(log))).toBe(true);
    else expect(logs).toEqual([]);
  });
});

describe('resolveDaemonUpdateMode', () => {
  it.each([
    {
      name: 'npm source, auto-update disabled: check only, local policy before network',
      config: { autoUpdate: { enabled: false, source: 'npm', channel: 'beta' }, nodeRole: 'core' },
      network: { autoUpdate: { allowPrerelease: false, channel: 'latest' } },
      expected: { mode: 'npm-check-only', policy: { allowPrerelease: false, source: 'npm', channel: 'beta' } },
    },
    {
      name: 'npm source, auto-update enabled: auto-apply with the node role',
      config: { autoUpdate: { enabled: true, source: 'npm', repo: GIT_AU.repo, branch: 'main' }, nodeRole: 'core' },
      network: null,
      expected: { mode: 'npm-auto-apply', au: expect.objectContaining({ enabled: true, source: 'npm' }), nodeRole: 'core' },
    },
    {
      name: 'npm source, auto-update enabled, no node role: auto-apply as an edge node (the default)',
      config: { autoUpdate: { enabled: true, source: 'npm', repo: GIT_AU.repo, branch: 'main' } },
      network: null,
      expected: { mode: 'npm-auto-apply', au: expect.objectContaining({ enabled: true, source: 'npm' }), nodeRole: 'edge' },
    },
    {
      name: 'git source, auto-update enabled: git with the merged config',
      config: { autoUpdate: { enabled: true, source: 'git', repo: GIT_AU.repo, branch: 'main', checkIntervalMinutes: 3 } },
      network: null,
      expected: { mode: 'git', au: expect.objectContaining({ repo: GIT_AU.repo, branch: 'main', checkIntervalMinutes: 3 }) },
    },
    {
      name: 'git source, auto-update disabled',
      config: { autoUpdate: { enabled: false, source: 'git' } },
      network: null,
      expected: { mode: 'git-disabled' },
    },
    {
      name: 'monorepo source',
      config: { autoUpdate: { enabled: false, source: 'monorepo' } },
      network: null,
      expected: { mode: 'monorepo', autoUpdateEnabled: false },
    },
  ])('$name', ({ config, network, expected }) => {
    expect(resolveDaemonUpdateMode(config as any, network as any)).toEqual(expected);
  });
});

describe('startDaemonAutoUpdate', () => {
  beforeEach(() => { vi.stubEnv('DKG_HOME', home); });

  it('starts the resolved mode with the DKG home and a restart exit, and stop() stops that polling', async () => {
    const shutdown = vi.fn(async (_exitCode: number) => {});
    const polling: UpdatePolling = { stop: vi.fn() };
    const start = vi.fn((_state: DaemonUpdateMode, _deps: DaemonUpdatePollingDeps) => polling as UpdatePolling | null);
    const lastUpdateCheck = { upToDate: false, checkedAt: 0, latestCommit: '', latestVersion: '', channelTargetMissing: false };

    const autoUpdate = startDaemonAutoUpdate({
      config: { autoUpdate: { enabled: false, source: 'npm', channel: 'beta' }, nodeRole: 'core' } as any,
      network: null,
      isShuttingDown: () => false,
      setUpdating: () => {},
      log: () => {},
      lastUpdateCheck,
      shutdown,
    }, start);

    expect(start).toHaveBeenCalledOnce();
    const [state, deps] = start.mock.calls[0];
    expect(state).toEqual({ mode: 'npm-check-only', policy: { allowPrerelease: true, source: 'npm', channel: 'beta' } });
    expect(deps.dkgHome).toBe(home);
    expect(deps.lastUpdateCheck).toBe(lastUpdateCheck);

    await deps.onRestart();
    expect(shutdown).toHaveBeenCalledWith(DAEMON_EXIT_CODE_RESTART);

    autoUpdate.stop();
    expect(polling.stop).toHaveBeenCalledOnce();
  });

  it('stop() is safe when nothing polls', () => {
    const autoUpdate = startDaemonAutoUpdate({
      config: { autoUpdate: { enabled: false, source: 'monorepo' } } as any,
      network: null,
      isShuttingDown: () => false,
      setUpdating: () => {},
      log: () => {},
      lastUpdateCheck: { upToDate: false, checkedAt: 0, latestCommit: '', latestVersion: '', channelTargetMissing: false },
      shutdown: async () => {},
    }, () => null);
    expect(() => autoUpdate.stop()).not.toThrow();
  });
});
