import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The installers are replaced (the checks stay real), so a test sees which
// installer an apply reaches and nothing is built or installed.
const installers = vi.hoisted(() => ({
  npmCore: vi.fn(async (_version: string, _log: (msg: string) => void) => 'failed' as const),
  npmEdge: vi.fn(async (_version: string, _current: string | null, _log: (msg: string) => void) => 'failed' as const),
  git: vi.fn(async (..._args: unknown[]) => 'failed' as const),
}));
vi.mock('../src/daemon/auto-update.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/auto-update.js')>()),
  performNpmUpdate: installers.npmCore,
  performNpmUpdateEdge: installers.npmEdge,
  performUpdateWithStatus: installers.git,
}));
import type { ResolvedAutoUpdateConfig } from '../src/config.js';
import { _autoUpdateIo } from '../src/daemon/manifest.js';
import { createPersistedHoldoffDeadline, type UpdateHoldoffRecord } from '../src/daemon/auto-update-holdoff-deadline.js';
import { createUpdateHoldoffGate } from '../src/daemon/auto-update-holdoff-gate.js';
import {
  createGitUpdateRunCheck,
  createNpmUpdateRunCheck,
  describeUpdateHold,
  resolveCurrentGitTarget,
  resolveCurrentNpmTarget,
} from '../src/daemon/auto-update-runner.js';
import type { LastUpdateCheck } from '../src/daemon/state.js';

// How the git and npm runChecks drive the persisted rollout deadline through
// the gate, for every outcome of the poll and of the re-check after the hold.
// Only the check-level I/O is stubbed, and the installers are mocked (above).

const GIT_AU = {
  enabled: true,
  repo: 'git@github.com:owner/repo.git',
  branch: 'main',
  sshKeyPath: '/tmp/key',
  checkIntervalMinutes: 3,
} as ResolvedAutoUpdateConfig;

type RegistryReply = { latest: string } | 'error';

const io = {
  currentCommit: 'aaa1111',
  currentVersion: '9.0.0',
  /** Successive ls-remote answers (a SHA, or 'error'); the last one repeats. */
  remote: [] as string[],
  /** Successive registry answers; the last one repeats. */
  registry: [] as RegistryReply[],
};

function next<T>(queue: T[]): T {
  return queue.length > 1 ? queue.shift()! : queue[0];
}

beforeEach(() => {
  io.currentCommit = 'aaa1111';
  io.currentVersion = '9.0.0';
  io.remote = ['bbb2222'];
  io.registry = [{ latest: '9.1.0' }];
  for (const installer of Object.values(installers)) installer.mockClear();
  vi.spyOn(_autoUpdateIo, 'readFile').mockImplementation((async (path: any) => {
    if (String(path).endsWith('.current-commit')) return io.currentCommit;
    if (String(path).endsWith('.current-version')) return io.currentVersion;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }) as any);
  vi.spyOn(_autoUpdateIo, 'execFile').mockImplementation((async (file: string, args: string[]) => {
    if (file === 'git' && args[0] === 'ls-remote') {
      const sha = next(io.remote);
      if (sha === 'error') throw new Error('ls-remote: network unreachable');
      return { stdout: `${sha}\trefs/heads/main\n`, stderr: '' };
    }
    throw new Error(`unexpected execFile ${file} ${args.join(' ')}`);
  }) as any);
  vi.spyOn(_autoUpdateIo, 'fetch').mockImplementation((async () => {
    const reply = next(io.registry);
    return reply === 'error'
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => ({ 'dist-tags': reply }) };
  }) as any);
});
afterEach(() => { vi.restoreAllMocks(); });

function freshLastCheck(): LastUpdateCheck {
  return { upToDate: false, checkedAt: 0, latestCommit: '', latestVersion: '', channelTargetMissing: false };
}

/**
 * A gate over an in-memory record, with a 10-min window (a fresh draw holds
 * 300 s at now = 1_000). `restartDuringHold` makes a restart arrive during the
 * hold; `restartOnRetargetFrom` makes one arrive while a record for any other
 * target is written.
 */
function gateFixture(opts: {
  record?: UpdateHoldoffRecord;
  restartDuringHold?: boolean;
  restartOnRetargetFrom?: string;
} = {}) {
  let shuttingDown = false;
  let current: UpdateHoldoffRecord | null = opts.record ?? null;
  const store = {
    get record() { return current; },
    read: vi.fn(async () => current),
    write: vi.fn(async (record: UpdateHoldoffRecord) => {
      current = record;
      if (opts.restartOnRetargetFrom !== undefined && record.target !== opts.restartOnRetargetFrom) shuttingDown = true;
    }),
    clear: vi.fn(async () => { current = null; }),
  };
  const rng = vi.fn(() => 0.5);
  const sleep = vi.fn(async () => { if (opts.restartDuringHold) shuttingDown = true; });
  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); };
  const gate = createUpdateHoldoffGate({
    deadline: createPersistedHoldoffDeadline({ store, jitterMs: 600_000, log, rng, now: () => 1_000 }),
    isShuttingDown: () => shuttingDown,
    setUpdating: () => {},
    log,
    sleep,
  });
  return { gate, store, rng, sleep, logs };
}

describe('describeUpdateHold', () => {
  it('words a fresh hold, a resumed hold and an already-passed deadline', () => {
    expect(describeUpdateHold(1_155_000, false))
      .toBe('holding 1155s before applying (rollout jitter — spreads fleet restarts).');
    expect(describeUpdateHold(75_000, true))
      .toBe('resuming the rollout hold-off carried over from before a restart — 75s left before applying.');
    expect(describeUpdateHold(0, true))
      .toBe('rollout hold-off deadline carried over from before a restart has passed — applying now.');
  });
});

describe('re-check adapters', () => {
  it('npm: a failed registry check is reported as failed, not as nothing to apply', async () => {
    io.registry = ['error'];
    expect(await resolveCurrentNpmTarget(() => {}, false)).toEqual({ status: 'failed' });
  });

  it('git: a failed ref check is reported as failed, not as nothing to apply', async () => {
    io.remote = ['error'];
    expect(await resolveCurrentGitTarget(GIT_AU, () => {})).toEqual({ status: 'failed' });
  });
});

describe('createNpmUpdateRunCheck — persisted rollout deadline', () => {
  function npmRunCheck(fixture: ReturnType<typeof gateFixture>, channel?: string, nodeRole: 'edge' | 'core' = 'core') {
    return createNpmUpdateRunCheck({
      log: (m) => fixture.logs.push(m),
      lastUpdateCheck: freshLastCheck(),
      allowPrerelease: false,
      channel,
      autoApply: { gate: fixture.gate, nodeRole, onRestart: async () => {} },
    });
  }

  it('keys the deadline by the detected version and keeps it across a restart mid-hold', async () => {
    const fixture = gateFixture({ restartDuringHold: true });
    await npmRunCheck(fixture)();
    expect(fixture.store.record).toEqual({ target: '9.1.0', deadlineEpochMs: 1_000 + 300_000 });
    expect(fixture.store.clear).not.toHaveBeenCalled();
    expect(installers.npmCore, 'hold ended in shutdown: installer never entered').not.toHaveBeenCalled();
  });

  it('drops the deadline when the node is up to date or the channel has no target, not on a registry error', async () => {
    io.currentVersion = '9.1.0';
    const fixture = gateFixture({ record: { target: '9.1.0', deadlineEpochMs: 500 } });

    await npmRunCheck(fixture)();
    expect(fixture.store.clear, 'up to date').toHaveBeenCalledTimes(1);

    await npmRunCheck(fixture, 'beta')(); // no "beta" dist-tag
    expect(fixture.store.clear, 'no channel target').toHaveBeenCalledTimes(2);

    io.registry = ['error'];
    fixture.store.clear.mockClear();
    await fixture.store.write({ target: '9.1.0', deadlineEpochMs: 500 });
    await npmRunCheck(fixture)();
    expect(fixture.store.clear, 'a registry error is transient: keep the deadline').not.toHaveBeenCalled();
    expect(fixture.store.record).toEqual({ target: '9.1.0', deadlineEpochMs: 500 });
  });

  it('a failed re-check keeps an expired deadline, and the next successful poll installs without a new hold', async () => {
    io.registry = [{ latest: '9.1.0' }, 'error', { latest: '9.1.0' }]; // poll, re-check fails, then fine
    const fixture = gateFixture({ record: { target: '9.1.0', deadlineEpochMs: 500 } });

    await npmRunCheck(fixture)();
    expect(installers.npmCore, 'nothing installed on a failed re-check').not.toHaveBeenCalled();
    expect(fixture.store.record).toEqual({ target: '9.1.0', deadlineEpochMs: 500 });
    expect(fixture.logs.some((m) => m.includes('re-check after the hold-off failed'))).toBe(true);

    await npmRunCheck(fixture)();
    expect(installers.npmCore, 'installer entered on the next poll').toHaveBeenCalledWith('9.1.0', expect.any(Function));
    expect(fixture.rng, 'no new hold drawn').not.toHaveBeenCalled();
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it.each([
    { nodeRole: 'edge' as const, installer: 'npmEdge' as const, other: 'npmCore' as const },
    { nodeRole: 'core' as const, installer: 'npmCore' as const, other: 'npmEdge' as const },
  ])('nodeRole $nodeRole installs through $installer, never $other', async ({ nodeRole, installer, other }) => {
    const fixture = gateFixture({ record: { target: '9.1.0', deadlineEpochMs: 500 } }); // due
    await npmRunCheck(fixture, undefined, nodeRole)();
    expect(installers[installer]).toHaveBeenCalledOnce();
    expect(installers[installer].mock.calls[0][0]).toBe('9.1.0');
    expect(installers[other]).not.toHaveBeenCalled();
  });

  it('records a newer version found by the re-check as due, and keeps it when a restart comes first', async () => {
    io.registry = [{ latest: '9.1.0' }, { latest: '9.2.0' }]; // detect 9.1.0, re-check finds 9.2.0
    const fixture = gateFixture({ record: { target: '9.1.0', deadlineEpochMs: 500 }, restartOnRetargetFrom: '9.1.0' });

    await npmRunCheck(fixture)();
    expect(fixture.store.record).toEqual({ target: '9.2.0', deadlineEpochMs: 1_000 });
    expect(installers.npmCore, 'shutdown began: installer never entered').not.toHaveBeenCalled();
  });
});

describe('createGitUpdateRunCheck — persisted rollout deadline', () => {
  function gitRunCheck(fixture: ReturnType<typeof gateFixture>) {
    return createGitUpdateRunCheck({
      gate: fixture.gate,
      log: (m) => fixture.logs.push(m),
      lastUpdateCheck: freshLastCheck(),
      au: GIT_AU,
      onRestart: async () => {},
    });
  }

  it('keys the deadline by the detected commit and keeps it across a restart mid-hold', async () => {
    const fixture = gateFixture({ restartDuringHold: true });
    await gitRunCheck(fixture)();
    expect(fixture.store.record).toEqual({ target: 'bbb2222', deadlineEpochMs: 1_000 + 300_000 });
    expect(fixture.store.clear).not.toHaveBeenCalled();
    expect(installers.git, 'hold ended in shutdown: updater never entered').not.toHaveBeenCalled();
  });

  it('drops the deadline when the node is up to date, not when the check fails', async () => {
    io.remote = ['aaa1111'];
    const fixture = gateFixture({ record: { target: 'bbb2222', deadlineEpochMs: 500 } });

    await gitRunCheck(fixture)();
    expect(fixture.store.clear, 'up to date').toHaveBeenCalledTimes(1);

    io.remote = ['error'];
    fixture.store.clear.mockClear();
    await fixture.store.write({ target: 'bbb2222', deadlineEpochMs: 500 });
    await gitRunCheck(fixture)();
    expect(fixture.store.clear, 'a failed check is transient: keep the deadline').not.toHaveBeenCalled();
    expect(fixture.store.record).toEqual({ target: 'bbb2222', deadlineEpochMs: 500 });
  });

  it('a failed re-check keeps an expired deadline, and the next successful poll applies without a new hold', async () => {
    io.remote = ['bbb2222', 'error', 'bbb2222']; // poll, re-check fails, then fine
    const fixture = gateFixture({ record: { target: 'bbb2222', deadlineEpochMs: 500 } });

    await gitRunCheck(fixture)();
    expect(installers.git, 'nothing applied on a failed re-check').not.toHaveBeenCalled();
    expect(fixture.store.record).toEqual({ target: 'bbb2222', deadlineEpochMs: 500 });
    expect(fixture.logs.some((m) => m.includes('re-check after the hold-off failed'))).toBe(true);

    await gitRunCheck(fixture)();
    expect(installers.git, 'updater entered on the next poll').toHaveBeenCalledWith(GIT_AU, expect.any(Function), { expectedCommit: 'bbb2222' });
    expect(fixture.rng, 'no new hold drawn').not.toHaveBeenCalled();
    expect(fixture.sleep).not.toHaveBeenCalled();
  });

  it('records a newer commit found by the re-check as due, and keeps it when a restart comes first', async () => {
    io.remote = ['bbb2222', 'ccc3333']; // detect bbb2222, re-check finds ccc3333
    const fixture = gateFixture({ record: { target: 'bbb2222', deadlineEpochMs: 500 }, restartOnRetargetFrom: 'bbb2222' });

    await gitRunCheck(fixture)();
    expect(fixture.store.record).toEqual({ target: 'ccc3333', deadlineEpochMs: 1_000 });
    expect(installers.git, 'shutdown began: updater never entered').not.toHaveBeenCalled();
  });
});
