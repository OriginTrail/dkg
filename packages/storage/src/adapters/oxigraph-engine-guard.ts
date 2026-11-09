import { Console } from 'node:console';
import v8 from 'node:v8';

/**
 * Keeps a rare fatal error of the JavaScript engine away from the embedded store.
 *
 * The optimizing compiler inlines calls from JavaScript into WebAssembly. If the
 * optimized code is invalidated during such a call, and the call returns a
 * reference, the engine has to rebuild that result. V8 without
 * https://github.com/v8/v8/commit/a7ea17f9df401a7db6e6c7f33783c3d7b05c0fb6 has no
 * handler for it and stops the process. Oxigraph's `Quad` term getters are such
 * calls, and every quad a query returns is read through them. Node.js has that
 * change from version 24 on; older versions get this inlining turned off, which
 * avoids the path and does not fix the engine.
 *
 * Engine flags belong to the process, so a flag set on any thread covers them
 * all. The compiler reads this one when it compiles a function, so code optimized
 * before it is set keeps the inlined calls: `OxigraphStore`'s constructor calls
 * this before it opens a store, and a quad can only come from a store.
 */
const ENGINE_FLAG = '--no-turbo-inline-js-wasm-calls';
const FIRST_NODE_MAJOR_WITH_THE_ENGINE_FIX = 24;

interface EngineGuardEnvironment {
  nodeVersion: string;
  execArgv: readonly string[];
  setEngineFlag(flag: string): void;
  say(line: string): void;
}

/**
 * Setting a flag with `--freeze-flags-after-init` stops the process in a way no
 * catch can see, so it must not be tried. Node.js refuses that option in
 * NODE_OPTIONS and a worker thread inherits its parent's, so `execArgv` shows it.
 * The last one given wins, as it does for the engine.
 */
function flagsAreFrozen(execArgv: readonly string[]): boolean {
  let frozen = false;
  for (const arg of execArgv) {
    const freeze = /^--(no-?)?freeze[-_]flags[-_]after[-_]init$/.exec(arg);
    if (freeze) frozen = freeze[1] === undefined;
  }
  return frozen;
}

export function applyEngineGuard({ nodeVersion, execArgv, setEngineFlag, say }: EngineGuardEnvironment): 'applied' | 'not-needed' | 'failed' {
  if (!(Number.parseInt(nodeVersion, 10) < FIRST_NODE_MAJOR_WITH_THE_ENGINE_FIX)) return 'not-needed';
  const inlining = `V8's inlining of calls into WebAssembly (${ENGINE_FLAG})`;
  const warn = (reason: string): 'failed' => {
    say(`[oxigraph] WARNING: could not turn off ${inlining}: ${reason}. `
      + `The embedded store still runs, but on Node.js ${nodeVersion} it is exposed to a rare fatal engine error unless the process starts with that flag`);
    return 'failed';
  };
  if (flagsAreFrozen(execArgv)) return warn('this process started with --freeze-flags-after-init');
  try {
    setEngineFlag(ENGINE_FLAG);
  } catch (error) {
    return warn(error instanceof Error ? error.message : String(error));
  }
  say(`[oxigraph] Turned off ${inlining} for this process, to avoid a rare fatal engine error in the embedded store on Node.js ${nodeVersion}`);
  return 'applied';
}

let guarded = false;

/** Once per thread. On stderr, which a command's own output doesn't use, and not through the global console: this isn't a test's to count. */
export function guardEngineForEmbeddedStore(): void {
  if (guarded) return;
  guarded = true;
  const stderr = new Console(process.stderr);
  applyEngineGuard({
    nodeVersion: process.versions.node,
    execArgv: process.execArgv,
    setEngineFlag: (flag) => v8.setFlagsFromString(flag),
    say: (line) => stderr.warn(line),
  });
}
