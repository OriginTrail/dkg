// SPDX-License-Identifier: Apache-2.0
import type { OxigraphStoreLaunch } from './oxigraph-store-launch.js';
import type { OxigraphLaunchHandle } from './oxigraph-launch-strategy.js';
import type { CgroupOomSnapshot } from './oxigraph-memory.js';

export type StoreOpenOutcome =
  | { outcome: 'ready'; listenerPid: number; probes: number }
  | { outcome: 'child-died' | 'timed-out' | 'superseded' };
export interface OxigraphStoreOpenAttempt {
  progress: (elapsedS: number, allowedS: number) => string;
  superseded?: () => boolean;
}
interface OpenOptions extends OxigraphStoreOpenAttempt {
  log: (message: string) => void;
  probeReady: (launch: OxigraphLaunchHandle) => Promise<number | null>;
  readCgroupOomSnapshot: (pid: number) => CgroupOomSnapshot | null;
  progressLogIntervalMs: number;
  readyIntervalMs: number;
}
/** Verify and record the same launch before boot or recovery declares it ready. */
export async function awaitOxigraphStoreOpen(
  launch: OxigraphStoreLaunch,
  ready: { timeoutMs: number; walBytes: number },
  options: OpenOptions,
): Promise<StoreOpenOutcome> {
    const { oxigraph } = launch;
    const startedAt = Date.now();
    let lastProgressLog = startedAt;
    let probes = 0;
    while (Date.now() < startedAt + ready.timeoutMs) {
      // GH#1400 — RocksDB writes no progress records during replay, so this
      // daemon-side line is the only thing distinguishing "recovering" from
      // "hung" for an operator watching a multi-minute open.
      if (ready.walBytes > 0 && Date.now() - lastProgressLog >= options.progressLogIntervalMs) {
        lastProgressLog = Date.now();
        options.log(options.progress(
          Math.round((Date.now() - startedAt) / 1000),
          Math.round(ready.timeoutMs / 1000),
        ));
      }
      if (options.superseded?.()) return { outcome: 'superseded' };
      probes += 1;
      // Our child exited while opening — almost always a bind or lock
      // failure. Never adopt whatever may be answering on the port (it could
      // be a foreign SPARQL server).
      if (!oxigraph.alive()) return { outcome: 'child-died' };
      const listenerPid = await options.probeReady(oxigraph);
      if (listenerPid !== null) {
        // Only trust a 200 if the child WE spawned is still alive and bound —
        // guards the race where a foreign server answers while our child has
        // just died on EADDRINUSE.
        if (!oxigraph.alive()) return { outcome: 'child-died' };
        oxigraph.captureOomSnapshot(listenerPid, options.readCgroupOomSnapshot);
        // Record before declaring ready, then look again: a child that exits
        // during the write is a failed open, not a ready server whose exit
        // handler has already started recovery.
        await launch.ready(listenerPid);
        if (options.superseded?.()) return { outcome: 'superseded' };
        if (!oxigraph.alive()) return { outcome: 'child-died' };
        return { outcome: 'ready', listenerPid, probes };
      }
      await new Promise((resolve) => setTimeout(resolve, options.readyIntervalMs));
    }
    return { outcome: 'timed-out' };
}
