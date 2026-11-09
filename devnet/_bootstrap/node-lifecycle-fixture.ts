import { inspectPsProcessSync } from '../../packages/cli/src/daemon/process-probe.js';
import { afterEach, beforeEach, expect } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessState, type DevnetPaths } from './node-lifecycle.js';

export let root: string;
export let paths: DevnetPaths;
export const children: ChildProcess[] = [];
export const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dkg-node-lifecycle-'));
  paths = { repoRoot: root, devnetDir: join(root, '.devnet') };
  for (const n of [1, 2, 3, 4, 5]) mkdirSync(join(paths.devnetDir, `node${n}`), { recursive: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  rmSync(root, { recursive: true, force: true });
});

export const pidFile = (n: number, name: 'daemon.pid' | 'devnet.pid') => join(paths.devnetDir, `node${n}`, name);

/**
 * A live process that only sleeps. By default it looks like what `devnet.sh` leaves running for a
 * node: its command line ends in `<repoRoot>/packages/cli/dist/cli.js daemon-worker`. Pass `plain`
 * for an unrelated process (what a recycled PID would be), or `argv` for exactly the arguments that
 * follow the script (a process that runs from the checkout without being a daemon). `ignoreTerm`
 * makes it survive SIGTERM.
 */
export function sleeper(options: { plain?: boolean; entry?: string; argv?: string[]; ignoreTerm?: boolean } = {}): ChildProcess {
  const args = ['-e', `${options.ignoreTerm ? "process.on('SIGTERM', () => {}); " : ''}setInterval(() => {}, 1000)`];
  if (options.argv) args.push(...options.argv);
  else if (!options.plain) args.push(options.entry ?? join(root, 'packages/cli/dist/cli.js'), 'daemon-worker');
  const child = spawn(process.execPath, args, { stdio: 'ignore' });
  children.push(child);
  return child;
}

/**
 * A zombie: a process that has exited but has not been collected by its parent (a `sleep` that never
 * waits for it), which is what a just-SIGKILLed daemon is until its parent or init reaps it.
 */
export async function zombie(): Promise<number> {
  const holder = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(holder);
  const pid = await new Promise<number>((resolve, reject) => {
    holder.stdout!.once('data', (chunk) => resolve(parseInt(String(chunk).trim(), 10)));
    holder.once('error', reject);
  });
  for (let i = 0; i < 50 && !readProcessState(pid)?.startsWith('Z'); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(readProcessState(pid), 'the helper must leave a zombie').toMatch(/^Z/);
  return pid;
}

/** A PID that is certainly dead: a child that has already exited and been reaped. */
export function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0']);
  return result.pid!;
}

export async function exited(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

export async function listen(handler: (headers: IncomingHttpHeaders, url: string) => { status: number; hang?: boolean }): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    const answer = handler(req.headers, req.url ?? '');
    if (answer.hang) return; // never answers
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, seen };
}

export function processIdentity(pid: number) {
  const observed = inspectPsProcessSync(pid);
  if (observed.state !== 'running') throw new Error(`Test process ${pid} is not running`);
  return observed.process;
}
