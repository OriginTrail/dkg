// OT-RFC-61 §9 — fleet snapshots, build-identity attestation, journal signature ledger.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.
// Depends on lib/ssh.mjs (transport) and node:fetch for public /api/status.

/**
 * Light or full snapshot of one core. Combines the SSH k=v snapshot with the
 * public HTTP /api/status (no auth; carries commit/buildTime/version + admission
 * + chain rpc counters). NEVER throws — unreachable => {alias, reachable:false}.
 * Returned record uses ONLY the alias (no host/IP — S6). Shape mirrors
 * schema/EVIDENCE.md `fleet_snapshot` per-core entry.
 * @param {object} core fleet.json core entry
 * @param {{light?: boolean, connectTimeoutSec?: number}} [opts]
 */
export async function snapshotCore(core, opts) { throw new Error('TODO'); }

/**
 * Snapshot all cores with bounded concurrency. Returns {ts, kind, cores: [...]}.
 * @param {object} fleet @param {{light?: boolean}} [opts]
 */
export async function snapshotFleet(fleet, opts) { throw new Error('TODO'); }

/**
 * Build-identity attestation (RFC-61 §3.1, review r1): identity is the
 * daemon-reported embedded commit/buildTime from /api/status, bound to worker
 * MainPID + ExecMainStartTimestamp from the same snapshot pass. Returns
 * {alias, commit, buildTime, workerPid, workerStartTs, attested: boolean,
 *  inconclusiveReason?: string}. Unknown/missing commit => attested:false.
 * @param {object} snapshotCoreResult
 */
export function attestBuildIdentity(snapshotCoreResult) { throw new Error('TODO'); }

/**
 * True when two attestations describe the SAME running artifact (commit equal,
 * pid equal, start ts equal). Used to detect mid-run SHA changes (§3.1: a
 * change invalidates all network-dependent SLIs).
 */
export function sameArtifact(a, b) { throw new Error('TODO'); }

/**
 * Capture per-core journal cursors (full snapshot includes them). Returns
 * {alias, cursor, valid}.
 * @param {object} fleet
 */
export async function captureJournalCursors(fleet) { throw new Error('TODO'); }

/**
 * Count forbidden-signature classes strictly after per-core cursors
 * (`journalctl -u <unit> --after-cursor=<c> -o cat` piped to a single awk/grep
 * program composed from ledger.json). Exit status checked: a vacuumed/invalid
 * cursor yields {cursorValid:false} and the caller scores INCONCLUSIVE — never
 * silent zeroes (§9.2). Raw matched lines go to the sidecar via the provided
 * callback, never returned in counts.
 * @param {object} fleet
 * @param {Array<{alias: string, cursor: string}>} cursors
 * @param {{ledger: object, sidecar?: (alias: string, lines: string[]) => void}} opts
 * @returns {Promise<Array<{alias, cursorValid, counts: Record<string, number>, gatedTotal, recordedTotal}>>}
 */
export async function journalSignatureDeltas(fleet, cursors, opts) { throw new Error('TODO'); }

/**
 * Load + validate ledger.json: {version, classes: [{id, disposition:
 * 'gated'|'recorded', pattern (RegExp source, applied per line), description}]}.
 * @param {string} path
 */
export function loadLedger(path) { throw new Error('TODO'); }
