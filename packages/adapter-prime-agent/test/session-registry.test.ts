import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isLoopbackBridgeUrl,
  isProcessAlive,
  isSafeSessionId,
  readLiveSessions,
  removeSessionDescriptor,
  selectSession,
  sessionDescriptorPath,
  writeSessionDescriptor,
} from '../src/session-registry.js';

let dir: string;
let sessionsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-registry-'));
  sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const descriptor = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-alpha',
  bridgeUrl: 'http://127.0.0.1:45001',
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ...over,
});

describe('loopback validation', () => {
  it('accepts loopback forms only', () => {
    expect(isLoopbackBridgeUrl('http://127.0.0.1:1234')).toBe(true);
    expect(isLoopbackBridgeUrl('http://localhost:1234')).toBe(true);
    expect(isLoopbackBridgeUrl('http://[::1]:1234')).toBe(true);
    expect(isLoopbackBridgeUrl('http://10.0.0.5:1234')).toBe(false);
    expect(isLoopbackBridgeUrl('http://evil.example.com')).toBe(false);
    expect(isLoopbackBridgeUrl('http://127.evil.example.com:1234')).toBe(false);
    expect(isLoopbackBridgeUrl('ftp://127.0.0.1')).toBe(false);
    expect(isLoopbackBridgeUrl(undefined)).toBe(false);
  });
});

describe('session id safety', () => {
  it('rejects path traversal in ids so a descriptor cannot escape its dir', () => {
    expect(isSafeSessionId('01924f7a-9a1e-7000-8000-abcdef012345')).toBe(true);
    expect(isSafeSessionId('../../etc/passwd')).toBe(false);
    expect(isSafeSessionId('a/b')).toBe(false);
    expect(isSafeSessionId('')).toBe(false);
    expect(() => sessionDescriptorPath(sessionsDir, '../escape')).toThrow(/unsafe session id/);
  });
});

describe('descriptor lifecycle', () => {
  it('writes and reads back a live descriptor', () => {
    writeSessionDescriptor(sessionsDir, descriptor());
    const live = readLiveSessions(sessionsDir);
    expect(live).toHaveLength(1);
    expect(live[0]!.sessionId).toBe('sess-alpha');
  });

  it('removes a descriptor on shutdown', () => {
    writeSessionDescriptor(sessionsDir, descriptor());
    removeSessionDescriptor(sessionsDir, 'sess-alpha');
    expect(readLiveSessions(sessionsDir)).toHaveLength(0);
  });

  it('prunes a descriptor whose owning process is dead', () => {
    // pid 2^31-1 is effectively guaranteed not to exist.
    writeSessionDescriptor(sessionsDir, descriptor({ sessionId: 'dead', pid: 2147483647 }));
    expect(readdirSync(sessionsDir)).toHaveLength(1);
    expect(readLiveSessions(sessionsDir)).toHaveLength(0);
    // pruned as a side effect, so a crash loop cannot grow the directory
    expect(readdirSync(sessionsDir)).toHaveLength(0);
  });

  it('skips a malformed descriptor without deleting another process\'s in-flight file', () => {
    writeFileSync(join(sessionsDir, 'broken.json'), '{not json');
    expect(readLiveSessions(sessionsDir)).toHaveLength(0);
    expect(existsSync(join(sessionsDir, 'broken.json'))).toBe(true);
  });

  it('publishes descriptors atomically without leaving temporary files', () => {
    writeSessionDescriptor(sessionsDir, descriptor());
    expect(readdirSync(sessionsDir)).toEqual(['sess-alpha.json']);
    expect(readLiveSessions(sessionsDir)).toHaveLength(1);
  });

  it('rejects a descriptor advertising a non-loopback bridge', () => {
    writeFileSync(
      join(sessionsDir, 'evil.json'),
      JSON.stringify(descriptor({ sessionId: 'evil', bridgeUrl: 'http://10.1.2.3:9999' })),
    );
    expect(readLiveSessions(sessionsDir)).toHaveLength(0);
  });

  it('returns an empty list for a missing directory', () => {
    expect(readLiveSessions(join(dir, 'nope'))).toEqual([]);
  });

  it('orders newest first', () => {
    writeSessionDescriptor(sessionsDir, descriptor({ sessionId: 'old', startedAt: '2020-01-01T00:00:00.000Z' }));
    writeSessionDescriptor(sessionsDir, descriptor({ sessionId: 'new', startedAt: '2030-01-01T00:00:00.000Z' }));
    expect(readLiveSessions(sessionsDir).map((s) => s.sessionId)).toEqual(['new', 'old']);
  });
});

describe('isProcessAlive', () => {
  it('is true for this process and false for nonsense pids', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2147483647)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('selectSession', () => {
  const a = descriptor({ sessionId: 'a' });
  const b = descriptor({ sessionId: 'b' });

  it('errors rather than silently falling back when an explicit id misses', () => {
    const r = selectSession([a as never], 'missing');
    expect(r.session).toBeUndefined();
    expect(r.error).toMatch(/no live Prime Agent session with id/);
  });

  it('selects the explicit id when present', () => {
    expect(selectSession([a as never, b as never], 'b').session?.sessionId).toBe('b');
  });

  it('is unambiguous with exactly one session', () => {
    const r = selectSession([a as never]);
    expect(r.session?.sessionId).toBe('a');
    expect(r.ambiguous).toBe(false);
  });

  it('flags ambiguity with several sessions and no explicit id', () => {
    const r = selectSession([a as never, b as never]);
    expect(r.session?.sessionId).toBe('a');
    expect(r.ambiguous).toBe(true);
  });

  it('errors with no sessions at all', () => {
    expect(selectSession([]).error).toMatch(/no live Prime Agent session/);
  });
});
