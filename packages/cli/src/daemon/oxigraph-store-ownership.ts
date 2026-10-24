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
import type { OxigraphBinaryLocations } from './oxigraph-binary.js';
import { recordOxigraphLaunch, type OxigraphLaunchRecord } from './oxigraph-owner-record.js';
import { reclaimHost, stopOrphanedOxigraph } from './oxigraph-orphan.js';
import type { OxigraphLaunchHandle } from './oxigraph-launch-strategy.js';
import type { StoreHold } from './oxigraph-reclaim-policy.js';
import type { OxigraphStoreOwnership } from './oxigraph-store-launch.js';

/** The two store operations a launch is built from. */
export interface OxigraphStoreOwnershipSteps {
  /**
   * Stop orphaned Oxigraph processes that hold the store lock. `held` is why
   * the store may still be held by this node's Oxigraph, or null when it is
   * free for a new launch.
   */
  reclaim(): Promise<{ held: StoreHold | null }>;
  /**
   * Record a spawned launch as the store's owner; the returned record adds
   * the verified Oxigraph once the launch is ready. Null when there can be
   * no record for it (Windows, or a launch that could not be identified).
   */
  recordLaunch(launcherPid: number): Promise<OxigraphLaunchRecord | null>;
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
 * `oxigraphBinaryLocations`), defaulting to `binaryPath` alone. `steps`
 * replaces both the reclaim and the owner record at once (tests only), so a
 * caller never runs one of the production steps by leaving it out.
 *
 * It serialises its own lifecycle: a launch's reclaim and record writes are
 * tracked, `close()` waits for them, and after closing it runs at most one
 * more reclaim, when the last launch's wrapper had already exited and no
 * reclaim since has found the store free.
 */
export function createOxigraphStoreOwnership(
  opts: OxigraphStoreOwnershipInput & {
    binaries?: OxigraphBinaryLocations;
    steps?: OxigraphStoreOwnershipSteps;
  },
): OxigraphStoreOwnership {
  const host = reclaimHost(opts.platform);
  const steps: OxigraphStoreOwnershipSteps = opts.steps ?? {
    reclaim: () => stopOrphanedOxigraph({
      location: opts.location,
      binaryPath: opts.binaryPath,
      binaries: opts.binaries,
      log: opts.log,
      io: host,
    }),
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
  let closing: Promise<void> | null = null;
  // The last launch spawned, until a reclaim that began after its wrapper
  // exited finds the store free: close() reclaims once more for it.
  let lastLaunch: OxigraphLaunchHandle | null = null;
  // Reclaims and owner-record writes in flight, which close() waits for.
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    const forget = (): void => { inFlight.delete(work); };
    work.then(forget, forget);
    return work;
  };
  return {
    async launch(spawn) {
      if (closed) return { kind: 'closed' };
      const exited = lastLaunch !== null && !lastLaunch.alive() ? lastLaunch : null;
      const { held } = await track(steps.reclaim());
      // This reclaim covered a launch whose wrapper had already exited.
      if (held === null && exited !== null && lastLaunch === exited) lastLaunch = null;
      if (closed) return { kind: 'closed' };
      // Spawning over it would fail on the lock, and recording the new launch
      // would replace the owner record that lets a later reclaim stop the
      // holder. Leave both for a later attempt.
      if (held !== null) return { kind: 'blocked', hold: held };
      const oxigraph = spawn();
      lastLaunch = oxigraph;
      const launcherPid = oxigraph.child.pid;
      // Recorded at spawn, so the reclaim can identify this launch's
      // Oxigraph even if the daemon dies before it is ready. A launch that
      // cannot be recorded is killed before the failure surfaces.
      let record: OxigraphLaunchRecord | null = null;
      if (launcherPid !== undefined) {
        try {
          record = await track(steps.recordLaunch(launcherPid));
        } catch (error) {
          oxigraph.terminate('SIGKILL');
          throw error;
        }
      }
      return {
        kind: 'launched',
        launch: {
          oxigraph,
          // Without a record (Windows, or a launch that could not be
          // identified) there is nothing to extend: the reclaim then relies
          // on the unrecorded rules.
          ready: async (oxigraphPid) => {
            if (record === null || closed) return;
            await track(record.markReady(oxigraphPid));
          },
        },
      };
    },
    close() {
      if (closing) return closing;
      closed = true;
      // Decided now, before the caller stops a live launch: a wrapper that
      // already exited on its own may have left its Oxigraph running.
      const stranded = lastLaunch !== null && !lastLaunch.alive() ? lastLaunch : null;
      closing = (async () => {
        await Promise.allSettled(inFlight);
        // Unless a reclaim in flight has covered it since.
        if (stranded !== null && lastLaunch === stranded) await steps.reclaim().catch(() => undefined);
      })();
      return closing;
    },
  };
}
