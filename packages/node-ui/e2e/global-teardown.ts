/**
 * Playwright global teardown -- counterpart to the bootstrap chained
 * into `webServer.command` (see e2e/bootstrap-devnet.ts).
 *
 * Only stops devnet processes that THIS run started. Pre-existing
 * nodes (recorded in the marker's `preExistingNodes`) are left alone
 * so a mixed state — e.g. operator had node1 running and tests
 * bootstrapped node2 — does not tear down unrelated daemons.
 *
 * Idempotent: safe to invoke even when no marker exists.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { PlaywrightManagedMarker } from './bootstrap-devnet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const DEVNET_DIR = resolve(REPO_ROOT, '.devnet');
function readMarker(markerFile: string): PlaywrightManagedMarker | null {
  if (!existsSync(markerFile)) return null;
  try {
    return JSON.parse(readFileSync(markerFile, 'utf8')) as PlaywrightManagedMarker;
  } catch {
    return null;
  }
}

async function stopPid(pid: number, label: string): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already exited
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch {
      console.log(`[playwright] stopped ${label} (PID ${pid})`);
      return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Owned ${label} (PID ${pid}) did not exit after SIGTERM`);
}

async function stopNode(devnetDir: string, nodeIndex: number): Promise<void> {
  const pidfile = resolve(devnetDir, `node${nodeIndex}`, 'devnet.pid');
  if (!existsSync(pidfile)) return;
  const pid = Number(stripVTControlCharacters(readFileSync(pidfile, 'utf8')).trim());
  if (Number.isFinite(pid) && pid > 0) {
    await stopPid(pid, `node${nodeIndex}`);
  }
  try { rmSync(pidfile, { force: true }); } catch { /* best-effort */ }
}

async function stopHardhat(devnetDir: string): Promise<void> {
  const pidfile = resolve(devnetDir, 'hardhat.pid');
  if (!existsSync(pidfile)) return;
  // Playwright forces terminal colors; older devnet launchers printed numeric
  // child.pid with ANSI colors into this file. Accept that owned legacy PID.
  const pid = Number(stripVTControlCharacters(readFileSync(pidfile, 'utf8')).trim());
  if (Number.isFinite(pid) && pid > 0) {
    await stopPid(pid, 'Hardhat');
  }
  try { rmSync(pidfile, { force: true }); } catch { /* best-effort */ }
}

export async function cleanupManagedDevnet(devnetDir: string): Promise<void> {
  const markerFile = resolve(devnetDir, '.playwright-managed');
  const marker = readMarker(markerFile);
  if (!marker) {
    console.log('[playwright] no managed-devnet marker -- leaving any running devnet alone');
    return;
  }

  const numNodes = parseInt(marker.numNodes, 10) || 1;
  const preExisting = new Set(marker.preExistingNodes ?? []);
  const startedNodes: number[] = [];
  for (let i = 1; i <= numNodes; i++) {
    if (!preExisting.has(i)) startedNodes.push(i);
  }

  if (startedNodes.length === 0) {
    console.log('[playwright] marker present but all nodes were pre-existing -- nothing to stop');
    try { rmSync(markerFile, { force: true }); } catch { /* best-effort */ }
    return;
  }

  console.log(
    `[playwright] stopping playwright-managed nodes: ${startedNodes.join(', ')}` +
    (preExisting.size ? ` (leaving pre-existing: ${[...preExisting].join(', ')})` : ''),
  );

  // Try every owned process even if one does not exit. Preserve the marker on
  // failure so the workflow cleanup can retry without losing ownership.
  const results = await Promise.allSettled(startedNodes.map(index => stopNode(devnetDir, index)));
  if (preExisting.size === 0 && !marker.preExistingHardhat) {
    results.push(...await Promise.allSettled([stopHardhat(devnetDir)]));
  }
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Managed devnet cleanup failed');
  rmSync(markerFile, { force: true });

  console.log('[playwright] managed devnet teardown complete');
}

export default async function globalTeardown(): Promise<void> {
  await cleanupManagedDevnet(DEVNET_DIR);
}
