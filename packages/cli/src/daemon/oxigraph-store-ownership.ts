/**
 * The production store ownership for one managed Oxigraph store: before each
 * spawn it reclaims the store from orphans (`oxigraph-orphan.ts`); after it,
 * it records the launch (`oxigraph-owner-record.ts`), and it adds the verified
 * Oxigraph once the launch is ready. It also tracks those writes, so
 * `close()` can wait for them. Built by the server for each start, with the
 * binary catalog its caller passes.
 *
 * No step rejects for an expected failure: the reclaim leaves a holder it
 * cannot stop to the spawn's own lock error, and a record that cannot be
 * written is logged, after which the reclaim falls back to the PID 1 rule. A
 * rejection would therefore be a defect, which the server treats as a failed
 * launch.
 */
import type { OxigraphBinaryCatalog } from './oxigraph-binary.js';
import { recordOxigraphOwner } from './oxigraph-owner-record.js';
import { stopOrphanedOxigraph } from './oxigraph-orphan.js';
import type { OxigraphStoreOwnership } from './oxigraph-store-launch.js';

/** The two store operations a launch is built from; replaceable in tests. */
export interface OxigraphStoreOwnershipSteps {
  /** Stop orphaned Oxigraph processes that hold the store lock. */
  reclaim(): Promise<void>;
  /** Write the owner record for one launch. */
  record(launch: { launcherPid: number; oxigraphPid?: number }): Promise<void>;
}

export function createOxigraphStoreOwnership(opts: {
  location: string;
  binaryPath: string;
  /** From `resolveOxigraphBinary`; defaults to `binaryPath` alone. */
  binaries?: OxigraphBinaryCatalog;
  log: (message: string) => void;
  steps?: Partial<OxigraphStoreOwnershipSteps>;
}): OxigraphStoreOwnership {
  const steps: OxigraphStoreOwnershipSteps = {
    reclaim: async () => {
      await stopOrphanedOxigraph({
        location: opts.location,
        binaryPath: opts.binaryPath,
        binaries: opts.binaries,
        log: opts.log,
      });
    },
    record: (launch) => recordOxigraphOwner({
      location: opts.location,
      binaryPath: opts.binaryPath,
      ...launch,
      log: opts.log,
    }),
    ...opts.steps,
  };
  let closed = false;
  const writes = new Set<Promise<void>>();
  const record = (launch: { launcherPid: number; oxigraphPid?: number }): Promise<void> => {
    if (closed) return Promise.resolve();
    const write = steps.record(launch);
    writes.add(write);
    const forget = (): void => { writes.delete(write); };
    write.then(forget, forget);
    return write;
  };
  return {
    launch: async (spawn) => {
      await steps.reclaim();
      if (closed) return null;
      const child = spawn();
      const launcherPid = child.pid;
      // Recorded at spawn, so the reclaim can identify this launch's
      // Oxigraph even if the daemon dies before it is ready.
      if (launcherPid !== undefined) await record({ launcherPid });
      return {
        child,
        ready: (oxigraphPid) => launcherPid === undefined
          ? Promise.resolve()
          : record({ launcherPid, oxigraphPid }),
      };
    },
    close: async () => {
      closed = true;
      await Promise.allSettled(writes);
    },
  };
}
