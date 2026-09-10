import { readFileSync } from 'node:fs';

// The CLI manifest is the packaged runtime-policy source, shared with release
// validation. This path is identical from src/ and the published dist/ module.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  engines?: { node?: unknown };
};
if (typeof manifest.engines?.node !== 'string' || manifest.engines.node.trim() === '') {
  throw new Error('DKG package.json must declare the Node runtime policy in engines.node');
}
export const NODE_SQLITE_SUPPORTED_RANGE = manifest.engines.node;

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
