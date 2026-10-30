/**
 * Minimal runtime capability probe shared by the user-facing CLI, daemon,
 * doctor, and auto-update paths. Keep this module free of DKG imports so it
 * can run before configuration, slots, or the agent are loaded.
 */

export const NODE_SQLITE_SUPPORTED_RANGE = '>=22.13.0 <23.0.0 || >=23.4.0';

/**
 * First release on each supported Node.js line with the 2026-10-21 security
 * fixes (CVE-2026-111497, a Brotli decoder RCE reachable through fetch(), plus
 * DNS and TLS hostname bugs). The capability probe cannot see these, so this is
 * the one place the version string matters.
 */
export const NODE_SECURITY_RELEASES: Readonly<Record<number, string>> = {
  22: '22.23.4',
  24: '24.22.1',
  26: '26.12.1',
};

export const NODE_SECURITY_ADVISORY_URL =
  'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';

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

function parseNodeVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Explain why this Node.js lacks published security fixes, or null when it has them. */
export function nodeSecurityAdvisory(version: string): string | null {
  const parsed = parseNodeVersion(version);
  if (parsed === null) return null;
  const [major, minor, patch] = parsed;
  const releases = Object.values(NODE_SECURITY_RELEASES).map((release) => `${release}+`);
  const anyRelease = `${releases.slice(0, -1).join(', ')} or ${releases[releases.length - 1]}`;
  const patched = NODE_SECURITY_RELEASES[major];
  if (patched === undefined) {
    // Lines newer than the table are assumed to include the fixes.
    if (major > Math.max(...Object.keys(NODE_SECURITY_RELEASES).map(Number))) return null;
    return (
      `Node.js ${version} is end-of-life and no longer receives security fixes. `
      + `Upgrade to Node.js ${anyRelease}: ${NODE_SECURITY_ADVISORY_URL}`
    );
  }
  const [, floorMinor, floorPatch] = parseNodeVersion(patched)!;
  if (minor > floorMinor || (minor === floorMinor && patch >= floorPatch)) return null;
  return (
    `Node.js ${version} is missing the 2026-10-21 security release (CVE-2026-111497 and others). `
    + `Upgrade to Node.js ${patched} or later: ${NODE_SECURITY_ADVISORY_URL}`
  );
}

/** Log and return whether this process can run the SQLite-backed DKG runtime. */
export function assertNodeRuntimeSupported(
  log: (message: string) => void,
  runtime: NodeRuntimeProbe = currentRuntime(),
): boolean {
  const failure = nodeRuntimeFailureMessage(runtime);
  if (failure !== null) {
    log(`FATAL: ${failure}`);
    return false;
  }
  // Warn instead of blocking: refusing to start would turn a missed Node.js
  // upgrade into an outage on every auto-update or restart.
  const advisory = nodeSecurityAdvisory(runtime.version);
  if (advisory !== null) log(`WARNING: ${advisory}`);
  return true;
}
