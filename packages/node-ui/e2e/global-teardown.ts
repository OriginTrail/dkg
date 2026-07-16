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
import type { PlaywrightManagedMarker } from './bootstrap-devnet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const DEVNET_DIR = resolve(REPO_ROOT, '.devnet');
const MARKER_FILE = resolve(DEVNET_DIR, '.playwright-managed');

function readMarker(): PlaywrightManagedMarker | null {
  if (!existsSync(MARKER_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MARKER_FILE, 'utf8')) as PlaywrightManagedMarker;
  } catch {
    return null;
  }
}

function stopPid(pid: number, label: string): void {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[playwright] stopped ${label} (PID ${pid})`);
  } catch {
    /* already exited */
  }
}

function stopNode(nodeIndex: number): void {
  const pidfile = resolve(DEVNET_DIR, `node${nodeIndex}`, 'devnet.pid');
  if (!existsSync(pidfile)) return;
  const pid = parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
  if (Number.isFinite(pid) && pid > 0) {
    stopPid(pid, `node${nodeIndex}`);
  }
  try { rmSync(pidfile, { force: true }); } catch { /* best-effort */ }
}

function stopHardhat(): void {
  const pidfile = resolve(DEVNET_DIR, 'hardhat.pid');
  if (!existsSync(pidfile)) return;
  const pid = parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
  if (Number.isFinite(pid) && pid > 0) {
    stopPid(pid, 'Hardhat');
  }
  try { rmSync(pidfile, { force: true }); } catch { /* best-effort */ }
}

export default async function globalTeardown(): Promise<void> {
  const marker = readMarker();
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
    try { rmSync(MARKER_FILE, { force: true }); } catch { /* best-effort */ }
    return;
  }

  console.log(
    `[playwright] stopping playwright-managed nodes: ${startedNodes.join(', ')}` +
    (preExisting.size ? ` (leaving pre-existing: ${[...preExisting].join(', ')})` : ''),
  );

  try {
    for (const nodeIndex of startedNodes) {
      stopNode(nodeIndex);
    }
    // Only stop Hardhat when we started a fresh cluster (no pre-existing nodes).
    if (preExisting.size === 0) {
      stopHardhat();
    }
  } finally {
    try { rmSync(MARKER_FILE, { force: true }); } catch { /* best-effort */ }
  }

  console.log('[playwright] managed devnet teardown complete');
}
