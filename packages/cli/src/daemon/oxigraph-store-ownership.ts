/**
 * The production store ownership for one managed Oxigraph store: reclaim the
 * store from orphans before each spawn (`oxigraph-orphan.ts`) and record each
 * launch (`oxigraph-owner-record.ts`). Built by the managed layer, which knows
 * the binary catalog.
 *
 * None of these steps rejects for an expected failure: the reclaim leaves a
 * holder it cannot stop to the spawn's own lock error, and a record that
 * cannot be written is logged, after which the reclaim falls back to the
 * PID 1 rule. A rejection would therefore be a defect, which the server
 * treats as a failed launch.
 */
import { recordOxigraphOwner } from './oxigraph-owner-record.js';
import { stopOrphanedOxigraph } from './oxigraph-orphan.js';
import type { OxigraphStoreOwnership } from './oxigraph-store-launch.js';

export function createOxigraphStoreOwnership(opts: {
  location: string;
  binaryPath: string;
  knownBinaryDirs?: readonly string[];
  log: (message: string) => void;
}): OxigraphStoreOwnership {
  const record = (launcherPid: number, oxigraphPid?: number): Promise<void> => recordOxigraphOwner({
    location: opts.location,
    binaryPath: opts.binaryPath,
    launcherPid,
    oxigraphPid,
    log: opts.log,
  });
  return {
    beforeSpawn: async () => { await stopOrphanedOxigraph(opts); },
    spawned: ({ launcherPid }) => record(launcherPid),
    ready: ({ launcherPid, oxigraphPid }) => record(launcherPid, oxigraphPid),
  };
}
