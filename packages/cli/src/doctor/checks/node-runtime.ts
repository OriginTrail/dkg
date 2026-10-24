/** §4.7 runtime capability check for the SQLite-backed DKG release, plus the Node.js security-release check. */
import type { Finding, StateSummary } from '../types.js';
import {
  NODE_SECURITY_RELEASES,
  NODE_SQLITE_SUPPORTED_RANGE,
  nodeSecurityAdvisory,
} from '../../node-runtime-preflight.js';

export function runNodeRuntimeCheck(state: StateSummary): Finding[] {
  if (state.runtime.nodeSqliteAvailable) return [];
  return [{
    check: 'node-runtime',
    severity: 'error',
    message: `Node.js ${state.runtime.nodeVersion} does not expose the node:sqlite builtin`,
    advisory:
      `DKG requires Node.js ${NODE_SQLITE_SUPPORTED_RANGE}. Upgrade Node.js, or enable --experimental-sqlite on a runtime that provides the builtin, then run 'dkg doctor' again.`,
    subject: state.runtime.nodeVersion,
    details: {
      nodeVersion: state.runtime.nodeVersion,
      nodeSqliteAvailable: state.runtime.nodeSqliteAvailable,
      probe: state.runtime.probe,
      supportedRange: NODE_SQLITE_SUPPORTED_RANGE,
    },
  }];
}

/** Warn (DKG still runs) when the running Node.js lacks published security fixes. */
export function runNodeSecurityCheck(state: StateSummary): Finding[] {
  const advisory = nodeSecurityAdvisory(state.runtime.nodeVersion);
  if (advisory === null) return [];
  return [{
    check: 'node-security',
    severity: 'warning',
    message: `Node.js ${state.runtime.nodeVersion} is missing published security fixes`,
    advisory,
    subject: state.runtime.nodeVersion,
    details: {
      nodeVersion: state.runtime.nodeVersion,
      patchedReleases: { ...NODE_SECURITY_RELEASES },
    },
  }];
}
