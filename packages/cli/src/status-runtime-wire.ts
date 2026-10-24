/**
 * The runtime part of the GET /api/status wire contract: the Node.js release
 * the daemon runs on, so an operator can check that a restarted node picked
 * up a Node.js upgrade. Only a caller that may administer the node gets it;
 * every other caller gets null.
 */
export interface DaemonRuntimeStatus {
  /** `process.version` of the daemon, for example `v22.23.4`. */
  nodeVersion: string;
}

export interface DaemonRuntimeStatusFields {
  /** Absent on daemons before 10.0.26. */
  runtime?: DaemonRuntimeStatus | null;
}
