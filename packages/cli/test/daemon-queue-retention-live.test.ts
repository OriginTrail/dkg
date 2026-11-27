/**
 * OT-RFC-73 P10b, P11, in a real daemon process (mock chain, throwaway home, no Hardhat): the retention wiring in `lifecycle.ts` does what the unit tests say.
 *  - the default (no `queueRetention`) creates nothing: no retention log line, no retention field on the `async_admission_usage` line;
 *  - `queueRetention.share.mode = "report"` starts the share sweep once the API is up, ticks it on its interval through the real queue and store, and stops it cleanly on
 *    SIGTERM; `queueRetention.publisher.mode = "report"` does the same for the publisher sweep, through the daemon's admission instance of the publisher queue, and starts
 *    nothing for the share queue;
 *  - a bad value fails the boot with a message that names the key (no silent default).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const MOCK_CHAIN = { chain: { type: 'mock' } };

const readLog = (home: string): Promise<string> => readFile(join(home, 'daemon.log'), 'utf8').catch(() => '');

async function waitForLog(home: string, text: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await readLog(home);
    if (log.includes(text)) return log;
    if (Date.now() > deadline) throw new Error(`daemon.log never contained ${JSON.stringify(text)}; it ended with:\n${log.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

it('with no queueRetention section the daemon creates no retention at all', async () => {
  let daemon: LiveDaemon | undefined;
  try {
    daemon = await startLiveDaemon({ authEnabled: false, extraConfig: MOCK_CHAIN, readyTimeoutMs: 120_000 });
    const log = await waitForLog(daemon.home, 'async_admission_usage interval_s=0 ', 30_000);     // the first periodic line is written at start
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const later = await readLog(daemon.home);
    expect(later).not.toMatch(/\[retention\]|AsyncPromoteRetention|async_promote_retention|AsyncLiftRetention|async_lift_retention/);
    expect(log).not.toMatch(/_retention/);
    expect(later).not.toMatch(/share_retention|lift_retention/);
  } finally {
    await stopLiveDaemon(daemon);
  }
}, 180_000);

it('report mode starts the sweep after the API is up, ticks it through the real queue, and stops it on SIGTERM', async () => {
  let daemon: LiveDaemon | undefined;
  try {
    daemon = await startLiveDaemon({
      authEnabled: false, readyTimeoutMs: 120_000,
      extraConfig: { ...MOCK_CHAIN, queueRetention: { share: { mode: 'report', intervalMs: 1_000 } } },
    });
    const log = await waitForLog(daemon.home, 'async_promote_retention_pass mode=report scanned=0', 60_000);
    expect(log).toMatch(/\[retention\] share retention started in report mode \(first tick in 1000 ms, then every 1000 ms\): it judges and counts, and deletes nothing/);
    expect(log.indexOf('[retention] share retention started')).toBeGreaterThan(log.indexOf('API listening on'));      // after the API is up
    expect(log).not.toMatch(/\[error\] \[retention\]|\[warn\] \[retention\]/);
    expect(log).not.toContain('DELETE mode');

    const closed = daemon.owner.closed;
    daemon.child.kill('SIGTERM');
    const exit = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the daemon did not stop within 30 s of SIGTERM')), 30_000))]);
    expect(exit).toMatchObject({ code: 0 });
    const after = await readLog(daemon.home);
    expect(after).toContain('Stopped.');
    expect(after).not.toMatch(/\[error\] \[retention\]|\[warn\] \[retention\]|still running/);
  } finally {
    await stopLiveDaemon(daemon);
  }
}, 240_000);

it('publisher report mode starts its sweep after the API is up, ticks it through the real queue, starts nothing for the share queue, and stops on SIGTERM', async () => {
  let daemon: LiveDaemon | undefined;
  try {
    daemon = await startLiveDaemon({
      authEnabled: false, readyTimeoutMs: 120_000,
      extraConfig: { ...MOCK_CHAIN, queueRetention: { publisher: { mode: 'report', intervalMs: 1_000 } } },
    });
    const log = await waitForLog(daemon.home, 'async_lift_retention_pass mode=report scanned=0', 60_000);
    expect(log).toMatch(/\[retention\] publisher retention started in report mode \(first tick in 1000 ms, then every 1000 ms\): it judges and counts, and deletes nothing/);
    expect(log.indexOf('[retention] publisher retention started')).toBeGreaterThan(log.indexOf('API listening on'));      // after the API is up
    expect(log).not.toMatch(/\[error\] \[retention\]|\[warn\] \[retention\]/);
    expect(log).not.toContain('DELETE mode');
    expect(log).not.toMatch(/share retention started|async_promote_retention/);                                          // the share queue's mode is off: nothing exists for it

    const closed = daemon.owner.closed;
    daemon.child.kill('SIGTERM');
    const exit = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the daemon did not stop within 30 s of SIGTERM')), 30_000))]);
    expect(exit).toMatchObject({ code: 0 });
    const after = await readLog(daemon.home);
    expect(after).toContain('Stopped.');
    expect(after).not.toMatch(/\[error\] \[retention\]|\[warn\] \[retention\]|still running/);
  } finally {
    await stopLiveDaemon(daemon);
  }
}, 240_000);

it('a bad value fails the boot and the error names the key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dkg-retention-bad-config-'));
  try {
    await writeFile(join(home, 'config.json'), JSON.stringify({
      name: 'retention-bad-config', apiPort: 0, listenPort: 0, apiHost: '127.0.0.1', nodeRole: 'edge', relay: 'none', auth: { enabled: false },
      store: { backend: 'oxigraph-worker', options: { path: join(home, 'store.nq') } }, ...MOCK_CHAIN, contextGraphs: [],
      queueRetention: { share: { mode: 'sometimes', batchSize: 5000, mod: 'x' }, publisher: { mode: 'sometimes', rescanIntervalMs: 5 } },
    }));
    const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
      env: { ...process.env, DKG_HOME: home, DKG_API_PORT: '0', DKG_NO_BLUE_GREEN: '1', DKG_DISABLE_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the daemon did not exit; output so far:\n${output}`)); }, 120_000);
      child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    expect(code).not.toBe(0);
    for (const key of ['queueRetention.share.mode', 'queueRetention.share.batchSize', 'queueRetention.share.mod', 'queueRetention.publisher.mode', 'queueRetention.publisher.rescanIntervalMs']) expect(output).toContain(key);
    await expect(readFile(join(home, 'api.port'), 'utf8')).rejects.toThrow();                         // it never got as far as listening
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 180_000);
