import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readNodeRoleFromConfigSync,
  releasesDir,
  slotEntryPoint,
} from './config.js';

/** Fully assembled Node command used to start or probe this daemon entrypoint. */
export interface DaemonNodeCommand {
  executable: string;
  args: readonly string[];
  entryPoint: string;
}

/**
 * Absolute path to THIS CLI's own entrypoint module. A built install runs
 * `cli.js`, while source execution (tsx / ts-node) runs `cli.ts`.
 */
function cliEntryPointPath(): string {
  const builtEntry = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (existsSync(builtEntry)) return builtEntry;
  const sourceEntry = fileURLToPath(new URL('./cli.ts', import.meta.url));
  if (existsSync(sourceEntry)) return sourceEntry;
  return builtEntry;
}

/**
 * Resolve the daemon entrypoint used by the supervisor on its next spawn.
 * Edge and non-blue-green nodes use this installed CLI; Core may use the
 * active blue-green slot.
 */
export function resolveDaemonEntryPoint(): string {
  if (process.env.DKG_NO_BLUE_GREEN) return cliEntryPointPath();
  if (readNodeRoleFromConfigSync() === 'edge') return cliEntryPointPath();
  const rDir = releasesDir();
  if (existsSync(rDir)) {
    const entry = slotEntryPoint(join(rDir, 'current'));
    if (entry) return entry;
  }
  return cliEntryPointPath();
}

/**
 * Resolve one complete daemon command. Every launch and executable probe goes
 * through this boundary so Node executable/exec-argv/entrypoint policy has one
 * owner. The selected entrypoint is retained for diagnostics and tests only;
 * callers execute `executable` with `args` without rebuilding the shape.
 */
export function resolveDaemonNodeCommand(...args: string[]): DaemonNodeCommand {
  const entryPoint = resolveDaemonEntryPoint();
  return {
    executable: process.execPath,
    args: [...process.execArgv, entryPoint, ...args],
    entryPoint,
  };
}
