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
import { recordOxigraphLaunch, type OxigraphLaunchRecord } from './oxigraph-owner-record.js';
import { reclaimHost, stopOrphanedOxigraph } from './oxigraph-orphan.js';
import type { OxigraphBinaryCatalog } from './oxigraph-reclaim-policy.js';
import type { OxigraphStoreOwnership } from './oxigraph-store-launch.js';

/** The two store operations a launch is built from. */
export interface OxigraphStoreOwnershipSteps {
  /** Stop orphaned Oxigraph processes that hold the store lock. */
  reclaim(): Promise<void>;
  /**
   * Record a spawned launch as the store's owner; the returned record adds
   * the verified Oxigraph once the launch is ready.
   */
  recordLaunch(launcherPid: number): Promise<OxigraphLaunchRecord>;
}

/** What the server tells a store ownership about the store it launches. */
export interface OxigraphStoreOwnershipInput {
  location: string;
  binaryPath: string;
  /** The host the server launches on: it selects the reclaim's probes and the record. */
  platform: NodeJS.Platform;
  log: (message: string) => void;
}

/**
 * The store ownership for one server start. `binaries` is what the reclaim
 * recognises as this node's Oxigraph (the resolved binary's
 * `oxigraphBinaryLocations`), defaulting to `binaryPath` alone. `steps` replaces both the reclaim and the
 * owner record at once (tests only), so a caller never runs one of the
 * production steps by leaving it out.
 */
export function createOxigraphStoreOwnership(
  opts: OxigraphStoreOwnershipInput & {
    binaries?: OxigraphBinaryCatalog;
    steps?: OxigraphStoreOwnershipSteps;
  },
): OxigraphStoreOwnership {
  const host = reclaimHost(opts.platform);
  const steps: OxigraphStoreOwnershipSteps = opts.steps ?? {
    reclaim: async () => {
      await stopOrphanedOxigraph({
        location: opts.location,
        binaryPath: opts.binaryPath,
        binaries: opts.binaries,
        log: opts.log,
        io: host,
      });
    },
    recordLaunch: (launcherPid) => recordOxigraphLaunch({
      location: opts.location,
      binaryPath: opts.binaryPath,
      launcherPid,
      platform: opts.platform,
      inspect: host.inspectProcess,
      bootId: host.bootId,
      log: opts.log,
    }),
  };
  let closed = false;
  // Owner-record writes in flight, which close() waits for.
  const writes = new Set<Promise<unknown>>();
  const track = <T>(write: Promise<T>): Promise<T> => {
    writes.add(write);
    const forget = (): void => { writes.delete(write); };
    write.then(forget, forget);
    return write;
  };
  const close = async (): Promise<void> => {
    closed = true;
    await Promise.allSettled(writes);
  };
  return {
    async launch(spawn) {
      await steps.reclaim();
      if (closed) return null;
      const attempt = spawn();
      const launcherPid = attempt.oxigraph.child.pid;
      // Recorded at spawn, so the reclaim can identify this launch's
      // Oxigraph even if the daemon dies before it is ready. A launch that
      // cannot be recorded is killed before the failure surfaces.
      let record: OxigraphLaunchRecord | null = null;
      if (launcherPid !== undefined) {
        try {
          record = await track(steps.recordLaunch(launcherPid));
        } catch (error) {
          attempt.oxigraph.terminate('SIGKILL');
          throw error;
        }
      }
      return {
        attempt,
        ready: async (oxigraphPid) => {
          if (record && !closed) await track(record.markReady(oxigraphPid));
        },
      };
    },
    close,
    async release() {
      await close();
      await steps.reclaim();
    },
  };
}
