import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * One of this CLI's own modules, given the URL of its built `.js`: that file
 * in a built install, the `.ts` beside it in a source checkout (tsx /
 * ts-node), or null when neither exists.
 */
export function ownModulePath(builtModule: URL): { path: string; source: boolean } | null {
  const built = fileURLToPath(builtModule);
  if (existsSync(built)) return { path: built, source: false };
  const source = built.replace(/\.js$/, '.ts');
  return existsSync(source) ? { path: source, source: true } : null;
}

/**
 * Node arguments that run one of this CLI's own helper modules (the managed
 * Oxigraph parent watchdog) as a separate process, given the URL of its built
 * `.js`. A built install runs that file; a source checkout (tsx, tests) has
 * only the `.ts`, which runs through tsx, the repository's source runner.
 * Unlike the daemon's own command, a helper does not inherit this process's
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
