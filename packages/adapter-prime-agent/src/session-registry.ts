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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrimeAgentSessionDescriptor } from './types.js';

/** A session id may become a filename, so keep it to a conservative charset. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;

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
  // Write-then-rename would be nicer, but a torn read is handled by the reader
  // (parse failures are skipped), and the payload is a single small object.
  writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
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
      hostname.startsWith('127.')
    );
  } catch {
    return false;
  }
}

/**
 * Every descriptor currently on disk whose owning process is still alive.
 * Stale files are pruned as a side effect so the directory cannot grow
 * unbounded across crashes.
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
    if (!descriptor) {
      if (prune) rmSync(full, { force: true });
      continue;
    }
    if (!isProcessAlive(descriptor.pid)) {
      if (prune) rmSync(full, { force: true });
      continue;
    }
    live.push(descriptor);
  }
  // Newest first: the session a user most recently started is the most likely
  // target when the UI does not name one explicitly.
  live.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return live;
}

/**
 * Resolve which session a request should go to.
 * - explicit id wins, and a miss is an error rather than a silent fallback;
 * - exactly one live session is unambiguous;
 * - several live sessions with no id selected is ambiguous by construction, so
 *   return the most recent but report it, letting the caller surface a choice.
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
