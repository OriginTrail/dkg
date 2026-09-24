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
 * One of this CLI's own modules, given the URL of its built `.js`: that file
 * in a built install, the `.ts` beside it in a source checkout (tsx /
 * ts-node), or null when neither exists.
 */
function ownModulePath(builtModule: URL): { path: string; source: boolean } | null {
  const built = fileURLToPath(builtModule);
  if (existsSync(built)) return { path: built, source: false };
  const source = built.replace(/\.js$/, '.ts');
  return existsSync(source) ? { path: source, source: true } : null;
}

/** Absolute path to THIS CLI's own entrypoint module. */
function cliEntryPointPath(): string {
  const builtEntry = new URL('./cli.js', import.meta.url);
  return ownModulePath(builtEntry)?.path ?? fileURLToPath(builtEntry);
}

/**
 * Node arguments that run one of this CLI's own helper modules (the managed
 * Oxigraph parent watchdog) as a separate process, given the URL of its built
 * `.js`. A built install runs that file; a source checkout (tsx, tests) has
 * only the `.ts`, which runs through tsx, the repository's source runner.
 * Unlike `resolveDaemonNodeCommand`, a helper does not inherit this process's
 * `execArgv`: inspector or heap flags meant for the daemon must not apply to
 * it, and a test runner's flags carry no TypeScript loader.
 */
export function resolveHelperModuleNodeArgs(builtModule: URL): string[] {
  const helper = ownModulePath(builtModule);
  if (!helper) {
    throw new Error(`CLI helper module not found: ${fileURLToPath(builtModule)} (or its .ts source)`);
  }
  return helper.source ? ['--import', import.meta.resolve('tsx'), helper.path] : [helper.path];
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
