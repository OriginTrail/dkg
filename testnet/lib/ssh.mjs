// Bounded-concurrency read-only SSH exec + k=v snapshot parsing (rfc59 port).
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.

/**
 * Run one remote command over SSH. STRICTLY read-only by convention — this
 * module never composes sudo/systemctl/write commands (S2 lives in config +
 * the snapshot script; this is just transport).
 * Options: BatchMode=yes, IdentitiesOnly=yes when identity given,
 * ConnectTimeout from fleet config, StrictHostKeyChecking=accept-new,
 * 2 attempts on connect failure.
 * @param {{host: string, sshUser: string, sshIdentity?: string}} target
 * @param {string} remoteCmd
 * @param {{timeoutMs?: number, connectTimeoutSec?: number}} [opts]
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export async function sshExec(target, remoteCmd, opts) { throw new Error('TODO'); }

/**
 * Map over targets with a concurrency cap (fleet.sshConcurrency, default 2 —
 * avoid tailnet connection storms). Never rejects; per-target result or
 * {ok:false, error} placeholder.
 * @template T,R @param {T[]} targets @param {number} limit @param {(t:T)=>Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(targets, limit, fn) { throw new Error('TODO'); }

/**
 * Parse `key=value` lines (one per line) from snapshot command output into an
 * object. Values may be base64-wrapped as b64:<data> (paths, multiline) —
 * decoded transparently. Unknown lines ignored. (rfc59 k=v pattern.)
 * @param {string} stdout @returns {Record<string, string>}
 */
export function parseKvOutput(stdout) { throw new Error('TODO'); }

/**
 * Compose the ONE compound read-only snapshot command for a core (light or
 * full). Emits k=v lines. Light: systemd show (ActiveState, MainPID,
 * NRestarts, ExecMainStartTimestamp), worker pid + rss (ps), cgroup
 * memory.current/peak/high/max + memory.events oom_kill + memory.pressure
 * (some avg10), `ss -tln` recv-q/backlog for listenPort, TCP connect probe
 * (bash /dev/tcp with timeout), df -B1 of storeFilesystem.
 * Full adds: store dir du -sb (via unit WorkingDirectory heuristic), journal
 * cursor (`journalctl -u <unit> -n 0 --show-cursor`).
 * MUST NOT contain sudo, systemctl (other than `systemctl show`), redirects to
 * files, or any state-changing construct — a test greps for this.
 * @param {{systemdUnit: string, listenPort: number, storeFilesystem: string}} core
 * @param {{light?: boolean}} [opts] @returns {string}
 */
export function snapshotCommand(core, opts) { throw new Error('TODO'); }
