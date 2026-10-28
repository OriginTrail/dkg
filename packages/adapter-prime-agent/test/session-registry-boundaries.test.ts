import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLoopbackBridgeUrl, isProcessAlive, readLiveSessions, removeSessionDescriptor, writeSessionDescriptor } from '../src/session-registry.js';

let root: string;
const descriptor = () => ({ sessionId: 'valid', bridgeUrl: 'http://127.0.0.1:45123', pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'prime-registry-boundaries-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('untrusted session descriptors', () => {
  it.each([null, [], {}, { ...descriptor(), pid: '123' }, { ...descriptor(), startedAt: 1 }, { ...descriptor(), sessionId: '../escape' }])(
    'skips malformed descriptor %j without deleting its bytes', value => {
      const path = join(root, 'invalid.json');
      const bytes = JSON.stringify(value);
      writeFileSync(path, bytes);
      expect(readLiveSessions(root)).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    },
  );

  it('survives an unreadable directory or descriptor and ignores unrelated entries', () => {
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'owned elsewhere');
    expect(readLiveSessions(file)).toEqual([]);
    mkdirSync(join(root, 'directory.json'));
    writeFileSync(join(root, 'unfinished.tmp'), '{not json');
    writeSessionDescriptor(root, descriptor());
    expect(readLiveSessions(root)).toEqual([descriptor()]);
    expect(existsSync(join(root, 'directory.json'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('owned elsewhere');
  });

  it('uses session ID as the total-order tie breaker for identical timestamps', () => {
    for (const sessionId of ['z', 'a', 'm']) writeSessionDescriptor(root, { ...descriptor(), sessionId });
    expect(readLiveSessions(root).map(s => s.sessionId)).toEqual(['a', 'm', 'z']);
  });

  it('removal with an unsafe ID leaves files outside the registry intact', () => {
    const child = join(root, 'sessions');
    mkdirSync(child);
    const outside = join(root, 'outside.json');
    writeFileSync(outside, 'keep me');
    expect(() => removeSessionDescriptor(child, '../outside')).not.toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
  });

  it.each(['not a URL', 'http://[broken', 'https://127.0.0.1.evil.test', 'file:///etc/passwd'])('rejects bridge URL %s', url => {
    expect(isLoopbackBridgeUrl(url)).toBe(false);
  });

  it('treats EPERM as alive but ESRCH as dead and only performs signal-zero probes', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    expect(isProcessAlive(123)).toBe(true);
    expect(kill).toHaveBeenLastCalledWith(123, 0);
    kill.mockImplementation(() => { throw Object.assign(new Error('not found'), { code: 'ESRCH' }); });
    expect(isProcessAlive(456)).toBe(false);
    expect(kill).toHaveBeenLastCalledWith(456, 0);
    kill.mockClear();
    for (const invalid of [NaN, Infinity, 0.5, -1, 0]) expect(isProcessAlive(invalid)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
