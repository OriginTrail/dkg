import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readNodeRoleFromConfigSync,
  releasesDir,
  slotEntryPoint,
} from './config.js';

/** Canonical Node command prefix used to start or probe this daemon entrypoint. */
export interface DaemonRestartCommand {
  nodeExecutable: string;
  nodeExecArgv: readonly string[];
  restartEntryPoint: string;
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
 * Resolve the complete command prefix shared by supervisor restarts and the
 * Edge post-install executable probe. Keeping both consumers on this model
 * prevents the verifier from drifting from the process the supervisor starts.
 */
export function resolveDaemonRestartCommand(): DaemonRestartCommand {
  return {
    nodeExecutable: process.execPath,
    nodeExecArgv: [...process.execArgv],
    restartEntryPoint: resolveDaemonEntryPoint(),
  };
}

/** Append daemon/CLI arguments to a canonical restart command. */
export function daemonRestartCommandArgs(
  command: DaemonRestartCommand,
  ...args: string[]
): string[] {
  return [...command.nodeExecArgv, command.restartEntryPoint, ...args];
}
