/**
 * The offline publisher inspector must not WRITE the queue while a daemon is running (OT-RFC-73 P11, AC7).
 *
 * `dkg publisher cancel | retry | clear` talk to the daemon, and fall back to an inspector of their own that opens the node's store directly when the daemon cannot be reached.
 * "Cannot be reached" is not "not running": a daemon that is starting, stalled, restarting, or one that answers a route it does not know with 404/405/501 is exactly as alive
 * as before, and its admission instance (admission, claims, the retention sweep) is the queue's one writer. A second process that writes the same control graph is not
 * excluded by the daemon's claim lock or by the job locks, so retention's verify-then-delete could meet a job the inspector just revived, and a clear could remove what an
 * admission just bound. The inspector therefore refuses every destructive command while the node's pid file names a live process, with the pid and what to do. The
 * inspecting commands (jobs, job, stats) are not guarded: they change no queue state, and they still fall back. They are not free of writes, though. With the file-backed
 * Oxigraph backends, closing the inspector's store rewrites the store file from what the inspector loaded (`OxigraphStore.close()` always flushes;
 * https://github.com/OriginTrail/dkg/issues/3551). Run them next to a stalled daemon only when needed.
 *
 * The detection is the one `dkg start` uses for "Daemon already running": the pid file of the selected node home and a liveness probe of that pid.
 */
import { isProcessRunning, readPid } from './config.js';

export class DaemonRunningError extends Error {
  readonly code = 'DKG_DAEMON_RUNNING';

  constructor(readonly command: string, readonly pid: number) {
    super(
      `Refusing to run "dkg publisher ${command}" offline: a daemon appears to be running (PID ${pid}) but did not answer the API. The offline inspector would write the publisher `
      + 'queue as a second writer next to the daemon. Try again once the daemon answers, or stop it first ("dkg stop"); if that PID is not a DKG daemon, remove the stale daemon.pid file.',
    );
    this.name = 'DaemonRunningError';
  }
}

export interface DaemonProbe {
  readPid(): Promise<number | null>;
  isProcessRunning(pid: number): boolean;
}

const nodeHomeProbe: DaemonProbe = { readPid, isProcessRunning };

/** Throws `DaemonRunningError` when the selected node home names a live daemon process. */
export async function assertNoDaemonForOfflineWrite(command: string, probe: DaemonProbe = nodeHomeProbe): Promise<void> {
  const pid = await probe.readPid();
  if (pid !== null && Number.isInteger(pid) && pid > 0 && probe.isProcessRunning(pid)) throw new DaemonRunningError(command, pid);
}
