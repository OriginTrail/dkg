import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, waitForDaemonReady } from './daemon.js';
import { seed } from './seed.js';

const here = fileURLToPath(import.meta.url);
const stateFile = join(dirname(here), '.daemon-state.json');

export default async function globalSetup() {
  // eslint-disable-next-line no-console
  console.log('[e2e] starting DKG daemon (this can take ~10s)…');
  const daemon = await startDaemon();
  // eslint-disable-next-line no-console
  console.log(`[e2e] daemon up on :${daemon.apiPort} (DKG_HOME=${daemon.dkgHome})`);

  // eslint-disable-next-line no-console
  console.log('[e2e] waiting for daemon to fully bootstrap (peerId)…');
  await waitForDaemonReady(daemon.apiPort, daemon.authToken);

  // eslint-disable-next-line no-console
  console.log('[e2e] seeding fixture data…');
  const seedState = await seed(daemon);
  // eslint-disable-next-line no-console
  console.log(`[e2e] seeded context graph "${seedState.contextGraphId}" with assertion "${seedState.assertionName}"`);

  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ daemon, seed: seedState }, null, 2));
}
