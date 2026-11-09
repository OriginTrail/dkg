/**
 * The marketplace lane's global teardown: the default suite's, which stops
 * the nodes and the Hardhat node this run started (its bootstrap's ownership
 * marker says which) and leaves a devnet it reused alone. When the run
 * started the whole devnet, the lane's Blazegraph container (nodes 3 and 4
 * keep their store in it when Docker is up) goes too; it carries the lane's
 * own name prefix, so no other devnet's container is touched.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PlaywrightManagedMarker } from '../bootstrap-devnet-runtime.js';
import { cleanupManagedDevnet } from '../global-teardown.js';
import { DEVNET_DIR } from './devnet.js';
import { DOCKER_NAME_PREFIX } from './topology.js';

function ownedWholeDevnet(): boolean {
  const marker = resolve(DEVNET_DIR, '.playwright-managed');
  if (!existsSync(marker)) return false;
  try {
    const m = JSON.parse(readFileSync(marker, 'utf8')) as PlaywrightManagedMarker;
    return (m.preExistingNodes ?? []).length === 0 && !m.preExistingHardhat;
  } catch {
    return false;
  }
}

export default async function globalTeardown(): Promise<void> {
  const owned = ownedWholeDevnet();
  await cleanupManagedDevnet(DEVNET_DIR);
  if (!owned) return;
  const container = `${DOCKER_NAME_PREFIX}-blazegraph`;
  try {
    await promisify(execFile)('docker', ['rm', '-f', container], { timeout: 30_000 });
    console.log(`[marketplace] removed the lane's Blazegraph container ${container}`);
  } catch {
    // No Docker, or no such container: nothing of the lane's is left there.
  }
}
