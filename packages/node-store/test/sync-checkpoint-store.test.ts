import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSyncCheckpointStore } from '../src/index.js';
import { DashboardDB } from './helpers/dashboard-db.js';

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-node-store-sync-checkpoint-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteSyncCheckpointStore — A3 sync resume checkpoints', () => {
  let now = Date.now();
  const manifestA = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const manifestB = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const prefixA = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

  beforeEach(() => {
    now = Date.now();
  });

  const checkpointStore = () => new SqliteSyncCheckpointStore(db, {
    clock: () => now,
    ttlMs: 24 * 60 * 60 * 1000,
  });

  it('round-trips, overwrites, deletes, and expires checkpoints', () => {
    const store = checkpointStore();
    store.set('peer|cg|durable|data', 500);
    expect(store.get('peer|cg|durable|data')).toEqual({
      offset: 500,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
    });

    store.set('peer|cg|durable|data', 750);
    expect(store.get('peer|cg|durable|data')).toEqual({
      offset: 750,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
    });

    store.delete('peer|cg|durable|data');
    expect(store.get('peer|cg|durable|data')).toBeUndefined();

    store.set('peer|cg|durable|meta', 100);
    now += 24 * 60 * 60 * 1000 + 1;
    expect(store.get('peer|cg|durable|meta')).toBeUndefined();
  });

  it('persists non-expired checkpoints across DashboardDB reopen and prunes stale rows', () => {
    const store = checkpointStore();
    store.set('peer|cg|swm|data', 42);
    store.set('peer|cg|swm|meta', 43);
    db.close();

    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get('peer|cg|swm|data')).toEqual({
      offset: 42,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
    });

    now += 24 * 60 * 60 * 1000 + 1;
    expect(reopened.get('peer|cg|swm|data')).toBeUndefined();
    expect(reopened.pruneExpired(now)).toBe(1);
    const count = (db.db.prepare(`SELECT COUNT(*) AS c FROM sync_checkpoints`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('persists the responder session with its verified offset across reopen', () => {
    const store = checkpointStore();
    const key = 'peer|cg|durable|data';
    const sessionExpiresAt = now + 10 * 60 * 1000;

    store.setResponderSession(key, 'durable-data:restart-safe', sessionExpiresAt);
    store.set(key, 573235);
    expect(store.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      responderSessionId: 'durable-data:restart-safe',
      responderSessionExpiresAtMs: sessionExpiresAt,
      responderSessionOffset: 573235,
    });

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get(key)).toMatchObject({
      offset: 573235,
      responderSessionId: 'durable-data:restart-safe',
      responderSessionExpiresAtMs: sessionExpiresAt,
    });

    now = sessionExpiresAt + 1;
    expect(reopened.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: sessionExpiresAt - 10 * 60 * 1000,
      expiresAtMs: sessionExpiresAt - 10 * 60 * 1000 + 24 * 60 * 60 * 1000,
    });
    expect(db.db.prepare(`
      SELECT responder_session_id, responder_session_expires_at
        FROM sync_checkpoints WHERE key = ?
    `).get(key)).toEqual({
      responder_session_id: null,
      responder_session_expires_at: null,
    });
  });

  it('persists a manifest-bound verified prefix across restart and safely rebinds it', () => {
    const key = 'peer|cg|durable|data';
    const sessionExpiresAt = now + 10 * 60 * 1000;
    const store = checkpointStore();

    store.setManifestBoundOffset(key, 573235, manifestA, now, prefixA);
    store.setResponderSession(key, 'durable-data:generation-a', sessionExpiresAt, now, manifestA);
    expect(store.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      manifestDigest: manifestA,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-a',
      responderSessionExpiresAtMs: sessionExpiresAt,
      responderSessionOffset: 573235,
    });

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get(key)).toMatchObject({
      offset: 573235,
      manifestDigest: manifestA,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-a',
    });

    // The requester has already proven this prefix is byte-identical in the
    // fresh META generation. Rebinding retains the verified offset and prefix
    // but must discard the responder token from the old immutable row list.
    now += 1;
    reopened.setManifestBoundOffset(key, 573235, manifestB, now, prefixA);
    expect(reopened.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
    });

    // Priming a fresh responder generation with the new manifest must not
    // reset the already-verified local prefix to zero.
    reopened.setResponderSession(
      key,
      'durable-data:generation-b',
      sessionExpiresAt,
      now,
      manifestB,
    );
    expect(reopened.get(key)).toMatchObject({
      offset: 573235,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-b',
    });

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const restarted = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(restarted.get(key)).toMatchObject({
      offset: 573235,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-b',
    });

    now = sessionExpiresAt + 1;
    expect(restarted.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: sessionExpiresAt - 10 * 60 * 1000 + 1,
      expiresAtMs: sessionExpiresAt - 10 * 60 * 1000 + 1 + 24 * 60 * 60 * 1000,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
    });
  });

  it('persists terminal manifest completion across restart and clears it on rebind', () => {
    const key = 'peer|cg|durable|data';
    const store = checkpointStore();
    store.setManifestBoundOffset(key, 6_357_721, manifestA, now, prefixA, true);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get(key)).toMatchObject({
      offset: 6_357_721,
      manifestDigest: manifestA,
      manifestPrefixDigest: prefixA,
      terminal: true,
    });

    reopened.setManifestBoundOffset(key, 512, manifestB, now + 1, prefixA);
    expect(reopened.get(key)?.terminal).toBeUndefined();
  });

  it('resets an offset when a responder session is bound to a different manifest', () => {
    const key = 'peer|cg|durable|data';
    const store = checkpointStore();
    store.setManifestBoundOffset(key, 4096, manifestA, now, prefixA);

    store.setResponderSession(
      key,
      'durable-data:unproven-generation',
      now + 60_000,
      now,
      manifestB,
    );

    expect(store.get(key)).toEqual({
      offset: 0,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      manifestDigest: manifestB,
      responderSessionId: 'durable-data:unproven-generation',
      responderSessionExpiresAtMs: now + 60_000,
      responderSessionOffset: 0,
    });

    // Legacy/non-manifest writes cannot leave a stale cryptographic binding or
    // responder token attached to an unrelated offset.
    store.set(key, 128, now + 1);
    expect(store.get(key)).toEqual({
      offset: 128,
      updatedAtMs: now + 1,
      expiresAtMs: now + 1 + 24 * 60 * 60 * 1000,
    });
  });

  it('rejects malformed manifest bindings', () => {
    const store = checkpointStore();
    expect(() => store.setManifestBoundOffset(
      'peer|cg|durable|data',
      1,
      'sha256:not-a-digest',
    )).toThrow('Invalid sync manifest digest');
    expect(() => store.setManifestBoundOffset(
      'peer|cg|durable|data',
      1,
      manifestA,
      now,
      'sha256:not-a-prefix',
    )).toThrow('Invalid sync manifest prefix digest');
  });

  it.each([
    ['invalid manifest digest', {
      manifest_digest: 'sha256:not-a-digest',
      manifest_prefix_digest: null,
      responder_session_id: null,
      responder_session_expires_at: null,
      responder_session_offset: null,
    }],
    ['orphan manifest prefix', {
      manifest_digest: null,
      manifest_prefix_digest: prefixA,
      responder_session_id: null,
      responder_session_expires_at: null,
      responder_session_offset: null,
    }],
    ['partial responder session', {
      manifest_digest: manifestA,
      manifest_prefix_digest: prefixA,
      responder_session_id: 'torn-session',
      responder_session_expires_at: now + 60_000,
      responder_session_offset: null,
    }],
  ])('fails closed and deletes a persisted row with %s', (_name, malformed) => {
    const key = `peer|cg|durable|data|checkpoint:v2|${_name}`;
    db.db.prepare(`
      INSERT INTO sync_checkpoints (
        key, offset, updated_at, expires_at,
        responder_session_id, responder_session_expires_at, responder_session_offset,
        manifest_digest, manifest_prefix_digest, terminal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      key,
      512,
      now,
      now + 60_000,
      malformed.responder_session_id,
      malformed.responder_session_expires_at,
      malformed.responder_session_offset,
      malformed.manifest_digest,
      malformed.manifest_prefix_digest,
    );

    expect(checkpointStore().get(key)).toBeUndefined();
    expect(db.db.prepare(
      'SELECT key FROM sync_checkpoints WHERE key = ?',
    ).get(key)).toBeUndefined();
  });

  it('clears a responder session on demand and keeps the verified offset', () => {
    const store = checkpointStore();
    const key = 'peer|cg|durable|data';
    store.setResponderSession(key, 'session-to-clear', now + 60_000);
    store.set(key, 2048);
    expect(store.get(key)).toMatchObject({ responderSessionId: 'session-to-clear', offset: 2048 });

    store.clearResponderSession(key);
    const cleared = store.get(key);
    expect(cleared).toMatchObject({ offset: 2048 });
    expect(cleared).not.toHaveProperty('responderSessionId');
    expect(cleared).not.toHaveProperty('responderSessionExpiresAtMs');

    // Clearing a key that was never stored is a no-op, not an error.
    expect(() => store.clearResponderSession('peer|cg|swm|meta')).not.toThrow();
    expect(store.get('peer|cg|swm|meta')).toBeUndefined();
  });

  it('treats a responder session that is already expired as a clear', () => {
    const store = checkpointStore();
    const key = 'peer|cg|durable|data';
    store.setResponderSession(key, 'live-session', now + 60_000);
    store.set(key, 777);

    store.setResponderSession(key, 'stale-session', now);
    const after = store.get(key);
    expect(after).toMatchObject({ offset: 777 });
    expect(after).not.toHaveProperty('responderSessionId');
  });
});
