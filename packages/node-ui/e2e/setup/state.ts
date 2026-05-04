import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonState } from './daemon.js';
import type { SeedState } from './seed.js';

const here = fileURLToPath(import.meta.url);
const stateFile = join(dirname(here), '.daemon-state.json');

let cached: { daemon: DaemonState; seed: SeedState } | null = null;

export function loadState(): { daemon: DaemonState; seed: SeedState } {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    throw new Error(
      `Could not load test daemon state from ${stateFile}. This file is ` +
        `created by Playwright's globalSetup; if you see this, the suite ` +
        `wasn't started through \`playwright test\` (e.g. running a fixture ` +
        `outside the suite). Original error: ${(err as Error).message}`,
    );
  }
  return cached!;
}
