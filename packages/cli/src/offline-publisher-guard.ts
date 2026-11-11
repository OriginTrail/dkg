/**
 * The offline publisher inspector must not open the node's store while a daemon is running (OT-RFC-73 P11, AC7; #3551).
 *
 * The `dkg publisher` commands talk to the daemon, and fall back to an inspector of their own that opens the node's store directly when the daemon cannot be reached.
 * "Cannot be reached" is not "not running": a daemon that is starting, stalled, restarting, or one that answers a route it does not know with 404/405/501 is exactly as alive
 * as before, and it owns the store.
 * - The destructive commands (cancel, retry, clear) would write the queue as a second writer. The daemon's admission instance (admission, claims, the retention sweep) is
 *   the queue's one writer, and a second process that writes the same control graph is not excluded by the daemon's claim lock or by the job locks, so retention's
 *   verify-then-delete could meet a job the inspector just revived, and a clear could remove what an admission just bound.
 * - The inspecting commands (jobs, job, stats) change no queue state, and they open the store read-only, so they cannot write it in any case. They would still read a
 *   store that the running daemon owns and may be changing, so what they show could already be out of date.
 * The inspector therefore refuses every command while the node's pid file names a live process, with the pid and what to do.
 *
 * The detection is the one `dkg start` uses for "Daemon already running": the pid file of the selected node home and a liveness probe of that pid.
 */
import { isProcessRunning, readPid } from './config.js';

export type OfflineInspectorAccess = 'read' | 'write';

const WHY_REFUSED: Record<OfflineInspectorAccess, string> = {
  write: 'The offline inspector would write the publisher queue as a second writer next to the daemon.',
  read: 'The offline inspector would read the store the daemon owns while the daemon may still be changing it.',
};

export class DaemonRunningError extends Error {
  readonly code = 'DKG_DAEMON_RUNNING';

  constructor(readonly command: string, readonly pid: number, readonly access: OfflineInspectorAccess = 'write') {
    super(
      `Refusing to run "dkg publisher ${command}" offline: a daemon appears to be running (PID ${pid}) but did not answer the API. ${WHY_REFUSED[access]} `
      + 'Try again once the daemon answers, or stop it first ("dkg stop"); if that PID is not a DKG daemon, remove the stale daemon.pid file.',
    );
    this.name = 'DaemonRunningError';
  }
}

export interface DaemonProbe {
  readPid(): Promise<number | null>;
  isProcessRunning(pid: number): boolean;
}

const nodeHomeProbe: DaemonProbe = { readPid, isProcessRunning };

async function assertNoDaemonForOfflineInspector(command: string, access: OfflineInspectorAccess, probe: DaemonProbe): Promise<void> {
  const pid = await probe.readPid();
  if (pid !== null && Number.isInteger(pid) && pid > 0 && probe.isProcessRunning(pid)) throw new DaemonRunningError(command, pid, access);
}

/** Throws `DaemonRunningError` when the selected node home names a live daemon process. For the commands that write the queue. */
export async function assertNoDaemonForOfflineWrite(command: string, probe: DaemonProbe = nodeHomeProbe): Promise<void> {
  await assertNoDaemonForOfflineInspector(command, 'write', probe);
}

/** Throws `DaemonRunningError` when the selected node home names a live daemon process. For the commands that only read the queue. */
export async function assertNoDaemonForOfflineRead(command: string, probe: DaemonProbe = nodeHomeProbe): Promise<void> {
  await assertNoDaemonForOfflineInspector(command, 'read', probe);
}
