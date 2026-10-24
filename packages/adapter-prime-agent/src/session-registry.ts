/**
 * Bridge discovery.
 *
 * Prime Agent loads extensions per session, into the worker process that owns
 * that session, so each live session binds its own loopback port. There is no
 * single well-known endpoint to point the daemon at. The extension therefore
 * publishes a descriptor file per session and removes it on shutdown; the
 * daemon reads the directory and picks a live bridge.
 *
 * The staleness problem is real: a crashed worker never removes its file, and
 * an OS may later hand the same port to an unrelated process. Two defences:
 *  1. `pid` is recorded and checked with signal 0 before a descriptor is used;
 *  2. `/health` echoes its `sessionId`, so the daemon can detect a descriptor
 *     that points at the wrong process even when the pid happens to be alive.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { PrimeAgentSessionDescriptor } from './types.js';

/** A session id may become a filename, so keep it to a conservative charset. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

// A dead-pid descriptor younger than this is never pruned: it may be a live
// republication that landed (atomic rename, fresh mtime) between our read and
// the rm. Mirrored in the extension's start-time prune (`extension.ts`).
const PRUNE_MIN_AGE_MS = 30_000;

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

export function sessionDescriptorPath(sessionsDir: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`unsafe session id: ${JSON.stringify(sessionId.slice(0, 32))}`);
  }
  return join(sessionsDir, `${sessionId}.json`);
}

/** Called by the extension when its bridge is listening. */
export function writeSessionDescriptor(
  sessionsDir: string,
  descriptor: PrimeAgentSessionDescriptor,
): string {
  mkdirSync(sessionsDir, { recursive: true });
  const path = sessionDescriptorPath(sessionsDir, descriptor.sessionId);
  const temporaryPath = join(
    sessionsDir,
    `.${descriptor.sessionId}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    // Same-directory rename is atomic: readers see either the complete old
    // descriptor or the complete new one, never a partially-written JSON file.
    writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return path;
}

/** Called by the extension on session shutdown. Never throws. */
export function removeSessionDescriptor(sessionsDir: string, sessionId: string): void {
  try {
    rmSync(sessionDescriptorPath(sessionsDir, sessionId), { force: true });
  } catch {
    /* best effort: a leftover file is pruned by the reader's pid check */
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function isOlderThanPruneAge(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs >= PRUNE_MIN_AGE_MS;
  } catch {
    return false; // already gone: nothing left to prune
  }
}

function parseDescriptor(raw: string): PrimeAgentSessionDescriptor | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PrimeAgentSessionDescriptor>;
    if (
      typeof parsed?.sessionId !== 'string' ||
      typeof parsed?.bridgeUrl !== 'string' ||
      typeof parsed?.pid !== 'number' ||
      typeof parsed?.startedAt !== 'string'
    ) {
      return null;
    }
    if (!isSafeSessionId(parsed.sessionId)) return null;
    if (!isLoopbackBridgeUrl(parsed.bridgeUrl)) return null;
    // A bad activity stamp invalidates only itself, not the descriptor: the
    // file still names a live bridge, ordering just falls back to startedAt.
    if (parsed.lastActiveAt !== undefined && typeof parsed.lastActiveAt !== 'string') {
      delete parsed.lastActiveAt;
    }
    return parsed as PrimeAgentSessionDescriptor;
  } catch {
    return null;
  }
}

/**
 * Loopback-only, mirroring the daemon's own rule for Hermes bridge targets. A
 * descriptor is data written by another process; treat it as untrusted input.
 */
export function isLoopbackBridgeUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname, protocol } = new URL(value);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      (isIP(hostname) === 4 && hostname.startsWith('127.'))
    );
  } catch {
    return false;
  }
}

/**
 * Every descriptor currently on disk whose owning process is still alive.
 * Stale files are pruned as a side effect so the directory cannot grow
 * unbounded across crashes.
 *
 * Ordered most recently ACTIVE first, not most recently started: Prime Agent's
 * daemon resumes sessions across terminal restarts, so a resumed session's
 * descriptor can be newer than the fresh one the operator is actually using.
 * Routing follows the session whose `lastActiveAt` moved last — that stamp is
 * written per turn, so the operator's next turn settles the election.
 */
export function readLiveSessions(
  sessionsDir: string,
  opts: { prune?: boolean } = {},
): PrimeAgentSessionDescriptor[] {
  const prune = opts.prune ?? true;
  if (!existsSync(sessionsDir)) return [];
  const live: PrimeAgentSessionDescriptor[] = [];
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(sessionsDir, entry);
    let descriptor: PrimeAgentSessionDescriptor | null = null;
    try {
      descriptor = parseDescriptor(readFileSync(full, 'utf8'));
    } catch {
      descriptor = null;
    }
    // A parse failure may be a concurrent or externally-managed write. Skip it
    // rather than deleting a descriptor whose ownership/liveness is unknown.
    if (!descriptor) continue;
    if (!isProcessAlive(descriptor.pid)) {
      // A dead pid alone does not justify deleting by path: a respawned
      // session republishes a LIVE descriptor at this exact path via atomic
      // rename, and that rename can land between our read and the rm. Only a
      // file old enough that no republication can explain its mtime is
      // removed; a wrongly deleted descriptor would be republished on that
      // session's next agent_start anyway, so the failure mode self-heals.
      if (prune && isOlderThanPruneAge(full)) rmSync(full, { force: true });
      continue;
    }
    live.push(descriptor);
  }
  // Most recently active first; startedAt is both the fallback for descriptors
  // written before lastActiveAt existed and the tiebreak, and sessionId keeps
  // the order total so equal stamps cannot flap between reads.
  live.sort(
    (a, b) =>
      (b.lastActiveAt ?? b.startedAt).localeCompare(a.lastActiveAt ?? a.startedAt) ||
      b.startedAt.localeCompare(a.startedAt) ||
      a.sessionId.localeCompare(b.sessionId),
  );
  return live;
}

/**
 * Resolve which session a request should go to.
 * - explicit id wins, and a miss is an error rather than a silent fallback;
 * - exactly one live session is unambiguous;
 * - several live sessions with no id selected is ambiguous by construction, so
 *   return the most recently active one but report it, letting the caller
 *   surface a choice.
 */
export function selectSession(
  sessions: PrimeAgentSessionDescriptor[],
  requestedSessionId?: string,
): { session?: PrimeAgentSessionDescriptor; ambiguous: boolean; error?: string } {
  if (requestedSessionId) {
    const match = sessions.find((s) => s.sessionId === requestedSessionId);
    if (!match) {
      return { ambiguous: false, error: `no live Prime Agent session with id ${requestedSessionId}` };
    }
    return { session: match, ambiguous: false };
  }
  if (sessions.length === 0) {
    return { ambiguous: false, error: 'no live Prime Agent session' };
  }
  return { session: sessions[0], ambiguous: sessions.length > 1 };
}
