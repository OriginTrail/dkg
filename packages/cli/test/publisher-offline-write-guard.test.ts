import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import { ApiClient } from '../src/api-client.js';
import { DaemonRunningError, assertNoDaemonForOfflineRead, assertNoDaemonForOfflineWrite } from '../src/offline-publisher-guard.js';

// OT-RFC-73 P11 (AC7) and #3551: the offline publisher inspector refuses while a daemon is running. The `dkg publisher` commands fall back to an inspector that opens the
// node's store directly when the daemon cannot be reached; "cannot be reached" does not mean "not running", and the running daemon owns the store. `cancel | retry | clear`
// would write the queue as a second writer next to the daemon's admission instance and retention sweep; `jobs | job | stats` only read it, and open it read-only. The guard
// reads the pid file of the selected node home, as `dkg start` does.

describe('assertNoDaemonForOfflineWrite', () => {
  const probe = (pid: number | null, alive: boolean) => ({ readPid: async () => pid, isProcessRunning: () => alive });

  it('passes when the node home names no process, or a process that is gone', async () => {
    await expect(assertNoDaemonForOfflineWrite('clear', probe(null, false))).resolves.toBeUndefined();
    await expect(assertNoDaemonForOfflineWrite('clear', probe(4242, false))).resolves.toBeUndefined();
    await expect(assertNoDaemonForOfflineWrite('clear', probe(Number.NaN, true))).resolves.toBeUndefined();   // an unreadable pid file names nothing
    await expect(assertNoDaemonForOfflineWrite('clear', probe(0, true))).resolves.toBeUndefined();
  });

  it('refuses when the pid file names a live process, saying which command, which pid and what to do', async () => {
    const error = await assertNoDaemonForOfflineWrite('cancel', probe(4242, true)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRunningError);
    expect(error).toMatchObject({ name: 'DaemonRunningError', code: 'DKG_DAEMON_RUNNING', command: 'cancel', pid: 4242, access: 'write' });
    expect((error as Error).message).toContain('"dkg publisher cancel"');
    expect((error as Error).message).toContain('as a second writer next to the daemon');
    expect((error as Error).message).toContain('PID 4242');
    expect((error as Error).message).toContain('dkg stop');
    expect((error as Error).message).toContain('daemon.pid');
  });

  it('asks about the pid it read and nothing else', async () => {
    const asked: number[] = [];
    await assertNoDaemonForOfflineWrite('retry', { readPid: async () => 77, isProcessRunning: (pid) => { asked.push(pid); return false; } });
    expect(asked).toEqual([77]);
  });

  it('reads the pid file of the selected node home by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dkg-guard-home-'));
    const previous = process.env.DKG_HOME;
    process.env.DKG_HOME = home;
    try {
      await expect(assertNoDaemonForOfflineWrite('clear')).resolves.toBeUndefined();            // no pid file
      writeFileSync(join(home, 'daemon.pid'), String(process.pid));
      await expect(assertNoDaemonForOfflineWrite('clear')).rejects.toMatchObject({ code: 'DKG_DAEMON_RUNNING', pid: process.pid });
      writeFileSync(join(home, 'daemon.pid'), '999999999');                                      // a pid nothing has
      await expect(assertNoDaemonForOfflineWrite('clear')).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DKG_HOME; else process.env.DKG_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('assertNoDaemonForOfflineRead', () => {
  const probe = (pid: number | null, alive: boolean) => ({ readPid: async () => pid, isProcessRunning: () => alive });

  it('passes when the node home names no process, or a process that is gone', async () => {
    await expect(assertNoDaemonForOfflineRead('jobs', probe(null, false))).resolves.toBeUndefined();
    await expect(assertNoDaemonForOfflineRead('jobs', probe(4242, false))).resolves.toBeUndefined();
    await expect(assertNoDaemonForOfflineRead('jobs', probe(-1, true))).resolves.toBeUndefined();
  });

  it('refuses when the pid file names a live process, giving the reason that applies to a read', async () => {
    const error = await assertNoDaemonForOfflineRead('stats', probe(4242, true)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRunningError);
    expect(error).toMatchObject({ name: 'DaemonRunningError', code: 'DKG_DAEMON_RUNNING', command: 'stats', pid: 4242, access: 'read' });
    const message = (error as Error).message;
    expect(message).toContain('Refusing to run "dkg publisher stats" offline');
    expect(message).toContain('PID 4242');
    expect(message).toContain('would read the store the daemon owns while the daemon may still be changing it');
    expect(message).not.toContain('second writer');
    expect(message).toContain('dkg stop');
    expect(message).toContain('daemon.pid');
  });
});

describe('dkg publisher commands with a daemon that is running but does not answer', () => {
  let home: string;
  let previousHome: string | undefined;
  const inspector = {
    publisher: {
      cancel: vi.fn(async () => undefined),
      retryDetailed: vi.fn(async () => ({ retried: 0, blockedPendingRecovery: 0, skipped: 0 })),
      clear: vi.fn(async () => 3),
      list: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ jobId: 'job-1', status: 'accepted' })),
      getStats: vi.fn(async () => ({})),
    },
    stop: vi.fn(async () => undefined),
  };
  const created = vi.fn(async (_args: { dataDir: string; readOnly?: boolean }) => inspector);
  const unreachable = [
    ['the daemon is not running', new Error('Daemon is not running')],
    ['the connection is refused', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })],
    ['the daemon does not know the route', Object.assign(new Error('Not Found'), { httpStatus: 404 })],
    ['the method is not allowed', Object.assign(new Error('HTTP 405'), { httpStatus: 405 })],
  ] as const;
  // What each command does to the queue, and the inspector call that does it.
  const commands = [
    ['cancel', ['publisher', 'cancel', 'job-1'], inspector.publisher.cancel, 'write'],
    ['retry', ['publisher', 'retry'], inspector.publisher.retryDetailed, 'write'],
    ['clear', ['publisher', 'clear', 'finalized'], inspector.publisher.clear, 'write'],
    ['jobs', ['publisher', 'jobs'], inspector.publisher.list, 'read'],
    ['job', ['publisher', 'job', 'job-1'], inspector.publisher.getStatus, 'read'],
    ['stats', ['publisher', 'stats'], inspector.publisher.getStats, 'read'],
  ] as const;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => { throw new Error(`process.exit:${code}`); }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    previousHome = process.env.DKG_HOME;
    home = mkdtempSync(join(tmpdir(), 'dkg-guard-command-'));
    process.env.DKG_HOME = home;
    vi.doMock('../src/publisher-runner.js', () => ({ createPublisherInspector: created }));
    for (const fn of Object.values(inspector.publisher)) fn.mockClear();
    created.mockClear();
    inspector.stop.mockClear();
  });

  afterEach(() => {
    vi.doUnmock('../src/publisher-runner.js');
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.DKG_HOME; else process.env.DKG_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function run(args: readonly string[], error: Error): Promise<{ stderr: string; exitCode: string | undefined }> {
    vi.spyOn(ApiClient, 'connect').mockRejectedValue(error);
    const stderr: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
    const program = new Command();
    program.exitOverride();
    registerPublisherCommand(program);
    let exitCode: string | undefined;
    try { await program.parseAsync([...args], { from: 'user' }); } catch (e) { exitCode = (e as Error).message; }
    return { stderr: stderr.join('\n'), exitCode };
  }
  const liveDaemon = () => writeFileSync(join(home, 'daemon.pid'), String(process.pid));

  for (const [name, args, call, access] of commands) {
    describe(`dkg publisher ${name}`, () => {
      it.each(unreachable)('refuses while the node home names a live daemon, whatever made the API unreachable (%s), and opens no store', async (_why, error) => {
        liveDaemon();
        const { stderr, exitCode } = await run(args, error);
        expect(exitCode).toBe('process.exit:1');
        expect(stderr).toContain(`Refusing to run "dkg publisher ${name}" offline`);
        expect(stderr).toContain(`PID ${process.pid}`);
        expect(stderr).toContain(access === 'write' ? 'as a second writer' : 'read the store the daemon owns');
        expect(created).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
      });

      it(`falls back to the offline inspector, as before, when no daemon is running, opening the store ${access === 'read' ? 'read-only' : 'to write it'}`, async () => {
        const { exitCode } = await run(args, new Error('Daemon is not running'));
        expect(exitCode).toBeUndefined();
        expect(created).toHaveBeenCalledTimes(1);
        expect(created.mock.calls[0]![0].readOnly).toBe(access === 'read' ? true : undefined);
        expect(call).toHaveBeenCalledTimes(1);
        expect(inspector.stop).toHaveBeenCalledTimes(1);
      });

      it('falls back when the pid file names a process that is gone (a stale file)', async () => {
        writeFileSync(join(home, 'daemon.pid'), '999999999');
        const { exitCode } = await run(args, new Error('Daemon is not running'));
        expect(exitCode).toBeUndefined();
        expect(call).toHaveBeenCalledTimes(1);
      });

      it('does not touch the offline path at all when the API answers an error that is not "unreachable"', async () => {
        liveDaemon();
        const { exitCode, stderr } = await run(args, Object.assign(new Error('Forbidden'), { httpStatus: 403 }));
        expect(exitCode).toBe('process.exit:1');
        expect(stderr).toContain('Forbidden');
        expect(created).not.toHaveBeenCalled();
      });
    });
  }
});

describe('every offline fallback of the publisher command is guarded', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/commands/publisher.ts'), 'utf8');
  const READ_ONLY = new Set(['list', 'listPage', 'getStatus', 'inspectPreparedPayload', 'getStats']);
  const DESTRUCTIVE = new Set(['cancel', 'retryDetailed', 'clear']);
  const uses = [...source.matchAll(/inspector\.publisher\.(\w+)\(/g)].map((m) => ({ method: m[1]!, at: m.index! }));
  const inspectors = [...source.matchAll(/createPublisherInspector\(\{[^}]*\}\)/g)].map((m) => ({ text: m[0], at: m.index! }));

  it('decides, for every method the command calls on the inspector, whether it reads or writes (a new method fails here until it is classified)', () => {
    expect(uses.length).toBeGreaterThanOrEqual(7);
    expect(uses.filter((use) => !READ_ONLY.has(use.method) && !DESTRUCTIVE.has(use.method)).map((use) => use.method)).toEqual([]);
  });

  it('asks the guard before each inspector is created: the write guard where the command writes, the read guard and a read-only store where it only reads', () => {
    expect(inspectors).toHaveLength(6);
    const decided = inspectors.map((inspector, index) => {
      // the calls this command makes on its inspector: those before the next command's inspector is created
      const methods = uses.filter((use) => use.at > inspector.at && use.at < (inspectors[index + 1]?.at ?? source.length)).map((use) => use.method);
      const writes = methods.some((method) => DESTRUCTIVE.has(method));
      const fallback = source.slice(source.lastIndexOf('isDaemonUnreachable(err)', inspector.at), inspector.at);
      expect(methods.length, inspector.text).toBeGreaterThan(0);
      expect(fallback, `${methods}: guard before the inspector`).toContain(writes ? 'assertNoDaemonForOfflineWrite(' : 'assertNoDaemonForOfflineRead(');
      expect(fallback, `${methods}: the other guard`).not.toContain(writes ? 'assertNoDaemonForOfflineRead(' : 'assertNoDaemonForOfflineWrite(');
      expect(inspector.text.includes('readOnly: true'), `${methods}: read-only store`).toBe(!writes);
      return writes ? 'write' : 'read';
    });
    expect(decided.sort()).toEqual(['read', 'read', 'read', 'write', 'write', 'write']);
  });
});
