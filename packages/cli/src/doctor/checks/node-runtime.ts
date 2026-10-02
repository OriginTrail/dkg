/** §4.7 runtime capability check for the SQLite-backed DKG release. */
import type { Finding, StateSummary } from '../types.js';
import { NODE_SQLITE_SUPPORTED_RANGE } from '../../node-runtime-preflight.js';

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
