/**
 * Minimal runtime capability probe shared by the user-facing CLI, daemon,
 * doctor, and auto-update paths. Keep this module free of DKG imports so it
 * can run before configuration, slots, or the agent are loaded.
 */

export const NODE_SQLITE_SUPPORTED_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';

export interface NodeRuntimeProbe {
  version: string;
  getBuiltinModule?: (name: string) => unknown;
}

export interface NodeRuntimeStatus {
  nodeVersion: string;
  nodeSqliteAvailable: boolean;
  probe: 'getBuiltinModule' | 'unavailable';
}

function currentRuntime(): NodeRuntimeProbe {
  return process as NodeJS.Process & NodeRuntimeProbe;
}

/** Probe the builtin capability instead of inferring support from a version string. */
export function inspectNodeRuntime(runtime: NodeRuntimeProbe = currentRuntime()): NodeRuntimeStatus {
  const getBuiltinModule = runtime.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    return {
      nodeVersion: runtime.version,
      nodeSqliteAvailable: false,
      probe: 'unavailable',
    };
  }
  try {
    const nodeSqliteAvailable = Boolean(getBuiltinModule.call(runtime, 'node:sqlite'));
    return {
      nodeVersion: runtime.version,
      nodeSqliteAvailable,
      probe: 'getBuiltinModule',
    };
  } catch {
    return {
      nodeVersion: runtime.version,
      nodeSqliteAvailable: false,
      probe: 'getBuiltinModule',
    };
  }
}

export function nodeRuntimeFailureMessage(
  runtime: NodeRuntimeProbe = currentRuntime(),
): string | null {
  const status = inspectNodeRuntime(runtime);
  if (status.nodeSqliteAvailable) return null;
  return (
    `node:sqlite is unavailable in Node.js ${status.nodeVersion}; `
    + `DKG requires Node.js ${NODE_SQLITE_SUPPORTED_RANGE}. `
    + 'Upgrade Node.js or enable --experimental-sqlite on a runtime that provides the builtin.'
  );
}

/** Log and return whether this process can run the SQLite-backed DKG runtime. */
export function assertNodeRuntimeSupported(
  log: (message: string) => void,
  runtime: NodeRuntimeProbe = currentRuntime(),
): boolean {
  const failure = nodeRuntimeFailureMessage(runtime);
  if (failure === null) return true;
  log(`FATAL: ${failure}`);
  return false;
}
