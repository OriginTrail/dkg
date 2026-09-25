import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lsofLockHolders, procLockHolders } from '../../src/daemon/oxigraph-orphan.js';
import {
  procInspectProcess,
  psInspectProcess,
  type ProcessInspector,
} from '../../src/daemon/process-probe.js';

// Real-process helpers shared by the orphaned-Oxigraph test files.

export function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export const hostHasProcfs = existsSync('/proc/self/fd');
export const hostHas = (tool: string): boolean =>
  spawnSync(tool, ['-h'], { stdio: 'ignore' }).error === undefined;

/** Every lock-holder probe this host can run, not only its default. */
export function hostLockHolderProbes(): Array<[string, (lockPath: string) => Promise<number[]>]> {
  const probes: Array<[string, (lockPath: string) => Promise<number[]>]> = [];
  if (hostHas('lsof')) probes.push(['lsof', lsofLockHolders]);
  if (hostHasProcfs) probes.push(['procfs', procLockHolders]);
  return probes;
}

/** Every process-inspection probe this host can run, not only its default. */
export function hostProcessProbes(): Array<[string, ProcessInspector]> {
  const probes: Array<[string, ProcessInspector]> = [];
  if (hostHas('ps')) probes.push(['ps', psInspectProcess]);
  if (hostHasProcfs) probes.push(['procfs', procInspectProcess]);
  return probes;
}

export function killIfAlive(pid: number | undefined): void {
  if (pid === undefined || pidIsGone(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export interface WorkerProcess {
  child: ChildProcess;
  stderr(): string;
}

/** Start a real worker process that owns one managed Oxigraph and wait until it is ready. */
export async function startWorker(
  standinBinary: string,
  port: number,
  location: string,
): Promise<WorkerProcess> {
  const child = spawn(process.execPath, [
    '--import', 'tsx',
    fileURLToPath(new URL('./oxigraph-worker-process.ts', import.meta.url)),
    standinBinary,
    location,
    String(port),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const ready = await Promise.race([
    once(child.stdout!, 'data').then(() => true),
    once(child, 'exit').then(() => false),
  ]);
  if (!ready) throw new Error(`worker exited before its Oxigraph was ready:\n${stderr}`);
  return { child, stderr: () => stderr };
}

export function parentPid(pid: number): number | null {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

export async function stopWorker(worker: WorkerProcess): Promise<void> {
  const { child } = worker;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
