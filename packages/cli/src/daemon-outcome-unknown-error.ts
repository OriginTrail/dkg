/**
 * A long Knowledge Asset mutation (`vm/publish`, `swm/share`, `wm/import-file`,
 * or a create that also shares or publishes) reached the daemon but no response
 * arrived before the client deadline. The daemon keeps working after the client
 * disconnects, so the operation may still complete, and a blind retry can 409.
 */
export class DaemonOutcomeUnknownError extends Error {
  readonly code = 'OUTCOME_UNKNOWN';
  readonly method: string;
  readonly path: string;
  readonly timeoutMs: number;
  constructor(method: string, path: string, timeoutMs: number, historyHint: string) {
    super(
      `Outcome unknown: the daemon did not answer ${method} ${path} within ${Math.round(timeoutMs / 1000)}s. ` +
      `It keeps working after the client disconnects, so the operation may still complete. ${historyHint}`,
    );
    this.name = 'DaemonOutcomeUnknownError';
    this.method = method;
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}
