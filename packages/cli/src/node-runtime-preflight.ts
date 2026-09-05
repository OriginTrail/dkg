/** Capability check kept free of daemon, configuration and database imports. */
export const NODE_SQLITE_SUPPORTED_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';

export interface NodeRuntimeHost {
  version: string;
  getBuiltinModule?: (name: string) => unknown;
}

export interface NodeRuntimeStatus {
  nodeVersion: string;
  sqliteAvailable: boolean;
  requiredNodeRange: string;
}

export function inspectNodeRuntime(host: NodeRuntimeHost = process): NodeRuntimeStatus {
  let sqliteAvailable = false;
  try {
    const sqlite = host.getBuiltinModule?.('node:sqlite');
    sqliteAvailable = typeof sqlite === 'object' && sqlite !== null
      && 'DatabaseSync' in sqlite && typeof sqlite.DatabaseSync === 'function';
  } catch { /* Missing, disabled or unavailable built-in: report the capability failure. */ }
  return { nodeVersion: host.version, sqliteAvailable, requiredNodeRange: NODE_SQLITE_SUPPORTED_RANGE };
}

export function nodeRuntimeError(status: NodeRuntimeStatus): string | undefined {
  if (status.sqliteAvailable) return undefined;
  return `DKG requires node:sqlite support (Node.js ${NODE_SQLITE_SUPPORTED_RANGE}); `
    + `current runtime is ${status.nodeVersion} without usable node:sqlite. Upgrade Node.js `
    + 'or use a SQLite-enabled build. Older supported experimental builds must pass --experimental-sqlite.';
}

export function assertNodeRuntimeSupported(): void {
  const error = nodeRuntimeError(inspectNodeRuntime());
  if (error) throw new Error(error);
}

export function exitOnNodeRuntimeError(log: (message: string) => void): void {
  const error = nodeRuntimeError(inspectNodeRuntime());
  if (error) {
    log(error);
    process.exit(1);
  }
}
