// inbox-cursor.test.ts
//
// Pure-function tests for the shared inbox read-cursor helpers used by
// both `dkg_check_inbox` and `hooks/inject-inbox.mjs`. The two surfaces
// MUST agree on the same on-disk file and on the same daemon-identity
// hash — otherwise a notice fired by the hook will reference rows the
// tool can no longer see (or vice versa). These tests pin both
// behaviours.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advanceCursor,
  daemonIdentityHash,
  inboxCursorPath,
  loadInboxCursor,
  saveInboxCursor,
} from '../src/inbox-cursor.js';

describe('daemonIdentityHash', () => {
  it('is deterministic for identical inputs', () => {
    const a = daemonIdentityHash({ api: 'http://localhost:9200', sourcePath: '/a' });
    const b = daemonIdentityHash({ api: 'http://localhost:9200', sourcePath: '/a' });
    expect(a).toBe(b);
  });

  it('produces distinct hashes for different daemon APIs', () => {
    const a = daemonIdentityHash({ api: 'http://localhost:9200', sourcePath: null });
    const b = daemonIdentityHash({ api: 'http://localhost:9201', sourcePath: null });
    expect(a).not.toBe(b);
  });

  it('produces distinct hashes for the same API but different config sources (multi-workspace)', () => {
    const a = daemonIdentityHash({
      api: 'http://localhost:9200',
      sourcePath: '/proj-a/.dkg/config.yaml',
    });
    const b = daemonIdentityHash({
      api: 'http://localhost:9200',
      sourcePath: '/proj-b/.dkg/config.yaml',
    });
    expect(a).not.toBe(b);
  });

  it('returns a short hex string suitable for a filename suffix', () => {
    const hash = daemonIdentityHash({ api: 'http://localhost:9200', sourcePath: null });
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash.length).toBeLessThanOrEqual(16);
  });

  it('respects DKG_HOME so two daemons under different homes get different hashes', () => {
    const prior = process.env.DKG_HOME;
    try {
      process.env.DKG_HOME = '/tmp/home-a';
      const a = daemonIdentityHash({ api: 'http://localhost:9200', sourcePath: null });
      process.env.DKG_HOME = '/tmp/home-b';
      const b = daemonIdentityHash({ api: 'http://localhost:9200', sourcePath: null });
      expect(a).not.toBe(b);
    } finally {
      if (prior === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = prior;
    }
  });
});

describe('loadInboxCursor / saveInboxCursor', () => {
  // Sandbox the cache dir to the OS tmp so we don't touch the
  // operator's real ~/.cache/dkg-mcp/.
  const sandbox = path.join(
    os.tmpdir(),
    `dkg-mcp-cursor-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let priorHome: string | undefined;

  beforeEach(() => {
    fs.mkdirSync(sandbox, { recursive: true });
    priorHome = process.env.HOME;
    // Redirect os.homedir() by overriding HOME (the helper uses
    // os.homedir() which reads HOME on POSIX, USERPROFILE on win).
    process.env.HOME = sandbox;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const ident = { api: 'http://localhost:9200', sourcePath: null };

  it('returns ts=0, id=0 when no cursor file exists', () => {
    expect(loadInboxCursor(ident)).toEqual({ ts: 0, id: 0 });
  });

  it('round-trips an explicit compound cursor', () => {
    saveInboxCursor(ident, { ts: 1715680000000, id: 42 });
    expect(loadInboxCursor(ident)).toEqual({ ts: 1715680000000, id: 42 });
  });

  it('migrates a legacy `{ lastSeen }` cursor to `{ ts, id: 0 }`', () => {
    // The first version of `hooks/inject-inbox.mjs` wrote bare
    // `{ lastSeen }`. New readers must accept that shape and treat
    // `id` as 0 (acceptable one-shot upgrade cost: at most re-surface
    // the message whose id was at the boundary).
    fs.mkdirSync(path.dirname(inboxCursorPath(ident)), { recursive: true });
    fs.writeFileSync(inboxCursorPath(ident), JSON.stringify({ lastSeen: 1234 }));
    expect(loadInboxCursor(ident)).toEqual({ ts: 1234, id: 0 });
  });

  it('returns ts=0 when the file is malformed JSON (fail-open)', () => {
    fs.mkdirSync(path.dirname(inboxCursorPath(ident)), { recursive: true });
    fs.writeFileSync(inboxCursorPath(ident), '{not json}');
    expect(loadInboxCursor(ident)).toEqual({ ts: 0, id: 0 });
  });

  it('two distinct daemons keep separate state files', () => {
    const a = { api: 'http://localhost:9200', sourcePath: '/proj-a' };
    const b = { api: 'http://localhost:9201', sourcePath: '/proj-b' };
    saveInboxCursor(a, { ts: 1, id: 1 });
    saveInboxCursor(b, { ts: 9, id: 99 });
    expect(loadInboxCursor(a)).toEqual({ ts: 1, id: 1 });
    expect(loadInboxCursor(b)).toEqual({ ts: 9, id: 99 });
    expect(inboxCursorPath(a)).not.toBe(inboxCursorPath(b));
  });
});

describe('advanceCursor', () => {
  it('advances when the new row is strictly newer', () => {
    expect(
      advanceCursor({ ts: 100, id: 5 }, { ts: 200, id: 1 }),
    ).toEqual({ ts: 200, id: 1 });
  });

  it('advances when ts is equal but id is greater (compound bucket)', () => {
    expect(
      advanceCursor({ ts: 100, id: 5 }, { ts: 100, id: 7 }),
    ).toEqual({ ts: 100, id: 7 });
  });

  it('does NOT advance for an older or equal row', () => {
    const prev = { ts: 100, id: 5 };
    expect(advanceCursor(prev, { ts: 50, id: 999 })).toBe(prev);
    expect(advanceCursor(prev, { ts: 100, id: 5 })).toBe(prev);
    expect(advanceCursor(prev, { ts: 100, id: 4 })).toBe(prev);
  });
});
