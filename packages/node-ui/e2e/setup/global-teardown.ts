import { rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopDaemon } from './daemon.js';

const here = fileURLToPath(import.meta.url);
const stateFile = join(dirname(here), '.daemon-state.json');

export default async function globalTeardown() {
  // eslint-disable-next-line no-console
  console.log('[e2e] stopping daemon…');
  await stopDaemon();
  await rm(stateFile, { force: true }).catch(() => {});
}
