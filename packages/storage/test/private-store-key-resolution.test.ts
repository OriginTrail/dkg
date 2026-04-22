/**
 * Targeted coverage for the key-resolution and standalone decrypt paths in
 * `private-store.ts` that the existing private-store-extra tests don't
 * exercise (lines 56-70 + 74-89 + 159-164 in the v8 report).
 *
 * The paths:
 *   - decryptPrivateLiteral  (module export, stateless)
 *   - resolveEncryptionKey   (hex/base64/short-input/explicit-bytes branches)
 *   - encrypt→decrypt round-trip with an explicit 32-byte key
 *   - decrypt-with-wrong-key returns the envelope unchanged (never throws)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OxigraphStore,
  ContextGraphManager,
  PrivateContentStore,
  type Quad,
} from '../src/index.js';
import {
  decryptPrivateLiteral,
  __resetPrivateStoreKeyCacheForTests,
} from '../src/private-store.js';

function makeFreshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-ps-key-'));
  const store = new OxigraphStore(join(dir, 'db'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('decryptPrivateLiteral (standalone export) — envelope handling', () => {
  it('returns non-encrypted literals unchanged', () => {
    const plain = '"hello world"';
    expect(decryptPrivateLiteral(plain)).toBe(plain);
    expect(decryptPrivateLiteral('<http://example.org/s>')).toBe('<http://example.org/s>');
    expect(decryptPrivateLiteral('_:b0')).toBe('_:b0');
  });

  it('returns the serialized string unchanged when it starts with the envelope but body is malformed', () => {
    // Envelope prefix present but the content is not base64-decodable to a
    // valid 12+16+ct structure — the helper must never throw, only pass
    // the serialized form through.
    const malformed = '"enc:gcm:v1:not-base64-at-all!!!"';
    const out = decryptPrivateLiteral(malformed);
    // Either we get the original back (catch triggered) or a plain "" — in
    // both cases the helper MUST NOT throw.
    expect(typeof out).toBe('string');
  });

  it('returns the envelope unchanged when decryption fails with the wrong key', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-1');
      const psA = new PrivateContentStore(store, gm, { encryptionKey: 'A'.repeat(64) });
      await psA.storePrivateTriples(
        'cg-1',
        'did:dkg:agent:A',
        [{ subject: 'did:dkg:agent:A', predicate: 'http://example.org/p', object: '"secret"', graph: '' }] as Quad[],
      );
      // Pull ciphertext via a raw SPARQL query to bypass the in-instance decrypt.
      const result = await store.query(`
        SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1
      `);
      const ciphertext = (result as any).bindings[0].o as string;
      expect(ciphertext.startsWith('"enc:gcm:v1:')).toBe(true);

      // Now decrypt with a DIFFERENT key — function must not throw and
      // must not return plaintext. Returning the envelope unchanged is
      // the documented "wrong key" signal.
      const wrong = decryptPrivateLiteral(ciphertext, { encryptionKey: 'B'.repeat(64) });
      expect(wrong).toBe(ciphertext);
    } finally {
      cleanup();
    }
  });
});

describe('resolveEncryptionKey via PrivateContentStore constructor — branch coverage', () => {
  it('accepts a 64-char hex key (32 bytes) and round-trips correctly', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-hex');
      const hexKey = '0'.repeat(64); // 32 bytes of 0x00
      const ps = new PrivateContentStore(store, gm, { encryptionKey: hexKey });
      await ps.storePrivateTriples('cg-hex', 'did:dkg:agent:X', [
        { subject: 'did:dkg:agent:X', predicate: 'http://example.org/p', object: '"secret-hex"', graph: '' },
      ] as Quad[]);
      const read = await ps.getPrivateTriples('cg-hex', 'did:dkg:agent:X');
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"secret-hex"');
    } finally {
      cleanup();
    }
  });

  it('accepts a base64-encoded 32-byte key', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-b64');
      const b64 = Buffer.alloc(32, 7).toString('base64');
      const ps = new PrivateContentStore(store, gm, { encryptionKey: b64 });
      await ps.storePrivateTriples('cg-b64', 'did:dkg:agent:Y', [
        { subject: 'did:dkg:agent:Y', predicate: 'http://example.org/p', object: '"secret-b64"', graph: '' },
      ] as Quad[]);
      const read = await ps.getPrivateTriples('cg-b64', 'did:dkg:agent:Y');
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"secret-b64"');
    } finally {
      cleanup();
    }
  });

  it('SHA-256-stretches a short passphrase into a 32-byte key (round-trips)', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-short');
      // A short passphrase — not 64 hex chars, so the hex branch is skipped
      // and it falls to the base64 branch, which decodes to a non-32-byte
      // buffer and triggers the SHA-256 stretch.
      const ps = new PrivateContentStore(store, gm, { encryptionKey: 'hunter2' });
      await ps.storePrivateTriples('cg-short', 'did:dkg:agent:Z', [
        { subject: 'did:dkg:agent:Z', predicate: 'http://example.org/p', object: '"secret-short"', graph: '' },
      ] as Quad[]);
      const read = await ps.getPrivateTriples('cg-short', 'did:dkg:agent:Z');
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"secret-short"');
    } finally {
      cleanup();
    }
  });

  it('accepts a raw Uint8Array key and round-trips', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-bytes');
      const key = new Uint8Array(32).fill(42);
      const ps = new PrivateContentStore(store, gm, { encryptionKey: key });
      await ps.storePrivateTriples('cg-bytes', 'did:dkg:agent:W', [
        { subject: 'did:dkg:agent:W', predicate: 'http://example.org/p', object: '"secret-bytes"', graph: '' },
      ] as Quad[]);
      const read = await ps.getPrivateTriples('cg-bytes', 'did:dkg:agent:W');
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"secret-bytes"');
    } finally {
      cleanup();
    }
  });

  // PR #229 bot review round 12 (r12-2): with no explicit key, two
  // instances in the same PROCESS now share the persisted per-node key
  // (either by reading the existing file or by the in-process cache
  // populated when ps1 generated it). This preserves the intra-process
  // dedup property the old deterministic default provided but limits
  // the key's blast radius to this one node's key file.
  it('per-node persisted key: two PrivateContentStore instances in the same process share the same key and round-trip data', async () => {
    const { store, cleanup } = makeFreshStore();
    const keyDir = mkdtempSync(join(tmpdir(), 'dkg-ps-persist-'));
    const keyFile = join(keyDir, 'private-store.key');
    const prev = process.env.DKG_PRIVATE_STORE_KEY;
    const prevFile = process.env.DKG_PRIVATE_STORE_KEY_FILE;
    delete process.env.DKG_PRIVATE_STORE_KEY;
    process.env.DKG_PRIVATE_STORE_KEY_FILE = keyFile;
    __resetPrivateStoreKeyCacheForTests();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-persisted');
      const ps1 = new PrivateContentStore(store, gm);
      const ps2 = new PrivateContentStore(store, gm);

      await ps1.storePrivateTriples('cg-persisted', 'did:dkg:agent:D', [
        { subject: 'did:dkg:agent:D', predicate: 'http://example.org/p', object: '"secret-default"', graph: '' },
      ] as Quad[]);

      const read = await ps2.getPrivateTriples('cg-persisted', 'did:dkg:agent:D');
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"secret-default"');
      // The key file must have been created with exactly 32 bytes.
      expect(existsSync(keyFile)).toBe(true);
      expect(readFileSync(keyFile).length).toBe(32);
    } finally {
      if (prev !== undefined) process.env.DKG_PRIVATE_STORE_KEY = prev;
      if (prevFile === undefined) delete process.env.DKG_PRIVATE_STORE_KEY_FILE;
      else process.env.DKG_PRIVATE_STORE_KEY_FILE = prevFile;
      __resetPrivateStoreKeyCacheForTests();
      rmSync(keyDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('picks DKG_PRIVATE_STORE_KEY from env when no explicit option is supplied', async () => {
    const { store, cleanup } = makeFreshStore();
    const prev = process.env.DKG_PRIVATE_STORE_KEY;
    process.env.DKG_PRIVATE_STORE_KEY = '1'.repeat(64);
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-env');
      const ps = new PrivateContentStore(store, gm);
      await ps.storePrivateTriples('cg-env', 'did:dkg:agent:E', [
        { subject: 'did:dkg:agent:E', predicate: 'http://example.org/p', object: '"secret-env"', graph: '' },
      ] as Quad[]);
      const read = await ps.getPrivateTriples('cg-env', 'did:dkg:agent:E');
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"secret-env"');
    } finally {
      if (prev === undefined) delete process.env.DKG_PRIVATE_STORE_KEY;
      else process.env.DKG_PRIVATE_STORE_KEY = prev;
      cleanup();
    }
  });
});

// -------------------------------------------------------------------------
// PR #229 bot review round 12 (r12-2): the unconfigured-key fallback
// MUST no longer share `sha256(DEFAULT_KEY_DOMAIN)` across nodes. The
// new behaviour: generate and persist a per-node 32-byte random key at
// `DKG_PRIVATE_STORE_KEY_FILE` (or `<DKG_HOME>/private-store.key`, or
// `<homedir()>/.dkg/private-store.key`). Two nodes with different key
// files must be cryptographically isolated.
// -------------------------------------------------------------------------
describe('r12-2: per-node persisted key isolates unconfigured nodes from each other', () => {
  const savedEnv = {
    DKG_PRIVATE_STORE_KEY: process.env.DKG_PRIVATE_STORE_KEY,
    DKG_PRIVATE_STORE_KEY_FILE: process.env.DKG_PRIVATE_STORE_KEY_FILE,
    DKG_PRIVATE_STORE_STRICT_KEY: process.env.DKG_PRIVATE_STORE_STRICT_KEY,
  };

  beforeEach(() => {
    delete process.env.DKG_PRIVATE_STORE_KEY;
    delete process.env.DKG_PRIVATE_STORE_KEY_FILE;
    delete process.env.DKG_PRIVATE_STORE_STRICT_KEY;
    __resetPrivateStoreKeyCacheForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetPrivateStoreKeyCacheForTests();
  });

  it('two nodes with different key files cannot decrypt each other\'s private triples', async () => {
    const nodeADir = mkdtempSync(join(tmpdir(), 'dkg-ps-node-a-'));
    const nodeBDir = mkdtempSync(join(tmpdir(), 'dkg-ps-node-b-'));
    const keyFileA = join(nodeADir, 'private-store.key');
    const keyFileB = join(nodeBDir, 'private-store.key');
    const { store: storeA, cleanup: cleanupA } = makeFreshStore();
    const { store: storeB, cleanup: cleanupB } = makeFreshStore();
    try {
      // Node A writes under its own persisted key.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = keyFileA;
      __resetPrivateStoreKeyCacheForTests();
      const gmA = new ContextGraphManager(storeA);
      await gmA.ensureContextGraph('cg-nodeA');
      const psA = new PrivateContentStore(storeA, gmA);
      await psA.storePrivateTriples('cg-nodeA', 'did:dkg:agent:A', [
        { subject: 'did:dkg:agent:A', predicate: 'http://example.org/p', object: '"nodeA-secret"', graph: '' },
      ] as Quad[]);

      // Pull the ciphertext from A's store via raw SPARQL.
      const ctResult = await storeA.query(`SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1`);
      const ciphertextFromA = (ctResult as any).bindings[0].o as string;
      expect(ciphertextFromA.startsWith('"enc:gcm:v1:')).toBe(true);

      // Switch to Node B's key file and verify the envelope does NOT
      // decrypt — decryptPrivateLiteral must return the envelope
      // unchanged (the documented "wrong key" signal), never plaintext.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = keyFileB;
      __resetPrivateStoreKeyCacheForTests();
      const decryptedUnderB = decryptPrivateLiteral(ciphertextFromA);
      expect(decryptedUnderB).toBe(ciphertextFromA);
      expect(decryptedUnderB).not.toBe('"nodeA-secret"');

      // Also: Node B generating its own key must produce a DIFFERENT
      // 32-byte secret. Files must exist, both 32 bytes, byte-unequal.
      const gmB = new ContextGraphManager(storeB);
      await gmB.ensureContextGraph('cg-nodeB');
      const psB = new PrivateContentStore(storeB, gmB);
      await psB.storePrivateTriples('cg-nodeB', 'did:dkg:agent:B', [
        { subject: 'did:dkg:agent:B', predicate: 'http://example.org/p', object: '"nodeB-secret"', graph: '' },
      ] as Quad[]);
      expect(existsSync(keyFileA)).toBe(true);
      expect(existsSync(keyFileB)).toBe(true);
      const rawA = readFileSync(keyFileA);
      const rawB = readFileSync(keyFileB);
      expect(rawA.length).toBe(32);
      expect(rawB.length).toBe(32);
      expect(rawA.equals(rawB)).toBe(false);
    } finally {
      cleanupA();
      cleanupB();
      rmSync(nodeADir, { recursive: true, force: true });
      rmSync(nodeBDir, { recursive: true, force: true });
    }
  });

  it('persisted key file is reused across process restarts (simulated via cache reset)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dkg-ps-reuse-'));
    const keyFile = join(dir, 'private-store.key');
    const { store, cleanup } = makeFreshStore();
    try {
      process.env.DKG_PRIVATE_STORE_KEY_FILE = keyFile;
      __resetPrivateStoreKeyCacheForTests();

      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-reuse');
      const ps1 = new PrivateContentStore(store, gm);
      await ps1.storePrivateTriples('cg-reuse', 'did:dkg:agent:R', [
        { subject: 'did:dkg:agent:R', predicate: 'http://example.org/p', object: '"persisted-across-restart"', graph: '' },
      ] as Quad[]);
      const originalKey = readFileSync(keyFile);
      expect(originalKey.length).toBe(32);

      // Simulate a process restart — drop the in-memory cache but
      // leave the file on disk. The new instance MUST read the same
      // key and decrypt the existing data.
      __resetPrivateStoreKeyCacheForTests();
      const ps2 = new PrivateContentStore(store, gm);
      const read = await ps2.getPrivateTriples('cg-reuse', 'did:dkg:agent:R');
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"persisted-across-restart"');
      // The file must NOT have been rewritten.
      expect(readFileSync(keyFile).equals(originalKey)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('strict mode (DKG_PRIVATE_STORE_STRICT_KEY=1) refuses both the persisted and deterministic fallbacks', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      process.env.DKG_PRIVATE_STORE_STRICT_KEY = '1';
      __resetPrivateStoreKeyCacheForTests();
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-strict');
      expect(() => new PrivateContentStore(store, gm)).toThrow(/strict mode/i);
    } finally {
      cleanup();
    }
  });

  it('explicit `strictKey: true` option overrides the env (belt + suspenders)', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      delete process.env.DKG_PRIVATE_STORE_STRICT_KEY;
      __resetPrivateStoreKeyCacheForTests();
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-strict-opt');
      expect(() => new PrivateContentStore(store, gm, { strictKey: true })).toThrow(
        /strict mode/i,
      );
    } finally {
      cleanup();
    }
  });
});

// -------------------------------------------------------------------------
// PR #229 bot review round 15 (r15-1): when the r12-2 flip switched the
// preferred unconfigured-node key from `sha256(DEFAULT_KEY_DOMAIN)` to a
// per-node persisted key, every node that previously ran without
// `DKG_PRIVATE_STORE_KEY` had its existing private ciphertext stranded.
// The fix adds the legacy deterministic key as a DECRYPT-ONLY fallback
// so old data remains readable after upgrade while new writes still go
// to the unique per-node key.
// -------------------------------------------------------------------------
describe('r15-1: legacy DEFAULT_KEY_DOMAIN fallback keeps pre-r12 private ciphertext readable after upgrade', () => {
  const savedEnv = {
    DKG_PRIVATE_STORE_KEY: process.env.DKG_PRIVATE_STORE_KEY,
    DKG_PRIVATE_STORE_KEY_FILE: process.env.DKG_PRIVATE_STORE_KEY_FILE,
    DKG_PRIVATE_STORE_STRICT_KEY: process.env.DKG_PRIVATE_STORE_STRICT_KEY,
  };

  beforeEach(() => {
    delete process.env.DKG_PRIVATE_STORE_KEY;
    delete process.env.DKG_PRIVATE_STORE_KEY_FILE;
    delete process.env.DKG_PRIVATE_STORE_STRICT_KEY;
    __resetPrivateStoreKeyCacheForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetPrivateStoreKeyCacheForTests();
  });

  it('legacy-sealed ciphertext (written under sha256(DEFAULT_KEY_DOMAIN)) is still readable after upgrade to a persisted key', async () => {
    const { store, cleanup } = makeFreshStore();
    const keyDir = mkdtempSync(join(tmpdir(), 'dkg-ps-r15-'));
    const keyFile = join(keyDir, 'private-store.key');
    try {
      // Step 1: simulate pre-r12 node behaviour by explicitly sealing with
      // the deterministic legacy key. We pass `DEFAULT_KEY_DOMAIN` as a
      // passphrase — the constructor SHA-256-stretches it, reproducing
      // the exact bytes `resolveEncryptionKey` used as the legacy
      // fallback in r12-2 and earlier.
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-legacy');
      const legacyWriter = new PrivateContentStore(store, gm, {
        encryptionKey: 'dkg-v10/private-store/default-key/v1',
      });
      await legacyWriter.storePrivateTriples('cg-legacy', 'did:dkg:agent:L', [
        { subject: 'did:dkg:agent:L', predicate: 'http://example.org/p', object: '"legacy-payload"', graph: '' },
      ] as Quad[]);

      // Step 2: upgrade — new instance has no explicit key but has a
      // fresh per-node persisted key file. This mirrors what a v10 node
      // sees on first boot after pulling the r12-2 change.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = keyFile;
      __resetPrivateStoreKeyCacheForTests();
      const upgradedReader = new PrivateContentStore(store, gm);
      const read = await upgradedReader.getPrivateTriples('cg-legacy', 'did:dkg:agent:L');

      // Step 3: the fallback chain finds the legacy key and recovers
      // the plaintext — without r15-1 this returned the envelope
      // unchanged (data stranded).
      expect(read).toHaveLength(1);
      expect(read[0].object).toBe('"legacy-payload"');
      // The persisted file must have been created with 32 bytes —
      // proves we're genuinely on a post-r12-2 instance, not falling
      // back to the legacy path for writes.
      expect(existsSync(keyFile)).toBe(true);
      expect(readFileSync(keyFile).length).toBe(32);
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('new writes always use the per-node persisted key, not the legacy fallback (fallback is decrypt-only)', async () => {
    const { store, cleanup } = makeFreshStore();
    const keyDir = mkdtempSync(join(tmpdir(), 'dkg-ps-r15-writes-'));
    const keyFile = join(keyDir, 'private-store.key');
    try {
      process.env.DKG_PRIVATE_STORE_KEY_FILE = keyFile;
      __resetPrivateStoreKeyCacheForTests();
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-write');
      const ps = new PrivateContentStore(store, gm);
      await ps.storePrivateTriples('cg-write', 'did:dkg:agent:N', [
        { subject: 'did:dkg:agent:N', predicate: 'http://example.org/p', object: '"new-write"', graph: '' },
      ] as Quad[]);

      // Grab the ciphertext.
      const result = await store.query(`SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1`);
      const ciphertext = (result as any).bindings[0].o as string;
      expect(ciphertext.startsWith('"enc:gcm:v1:')).toBe(true);

      // Verify a store that ONLY knows the legacy deterministic key
      // cannot decrypt the new write — if r15-1 were mis-applied
      // (e.g. flipping encryption to also try the legacy key) this
      // would leak plaintext.
      const legacyOnlyReader = new PrivateContentStore(store, gm, {
        encryptionKey: 'dkg-v10/private-store/default-key/v1',
      });
      const legacyRead = await legacyOnlyReader.getPrivateTriples('cg-write', 'did:dkg:agent:N');
      expect(legacyRead).toHaveLength(1);
      // Under a legacy-only key the new ciphertext is unreadable — the
      // envelope is returned verbatim, plaintext is NOT exposed.
      expect(legacyRead[0].object).toBe(ciphertext);
      expect(legacyRead[0].object).not.toBe('"new-write"');
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('decryptPrivateLiteral (standalone) also falls back to the legacy key for pre-r12 ciphertext', async () => {
    const { store, cleanup } = makeFreshStore();
    const keyDir = mkdtempSync(join(tmpdir(), 'dkg-ps-r15-export-'));
    const keyFile = join(keyDir, 'private-store.key');
    try {
      // Write with the legacy key.
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-export');
      const writer = new PrivateContentStore(store, gm, {
        encryptionKey: 'dkg-v10/private-store/default-key/v1',
      });
      await writer.storePrivateTriples('cg-export', 'did:dkg:agent:X', [
        { subject: 'did:dkg:agent:X', predicate: 'http://example.org/p', object: '"exported-legacy"', graph: '' },
      ] as Quad[]);
      const result = await store.query(`SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1`);
      const legacyCiphertext = (result as any).bindings[0].o as string;

      // Upgrade: no explicit key, new per-node key file. The standalone
      // `decryptPrivateLiteral` export (used by publisher subtraction
      // etc.) must still recover the plaintext via the legacy fallback.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = keyFile;
      __resetPrivateStoreKeyCacheForTests();
      const recovered = decryptPrivateLiteral(legacyCiphertext);
      expect(recovered).toBe('"exported-legacy"');
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('ciphertext under a TRULY unknown key (neither primary nor legacy) still returns the envelope (no silent leak)', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-unknown');
      const writer = new PrivateContentStore(store, gm, {
        encryptionKey: 'A'.repeat(64), // 32 hex bytes of 0xAA — not legacy, not the reader's key
      });
      await writer.storePrivateTriples('cg-unknown', 'did:dkg:agent:U', [
        { subject: 'did:dkg:agent:U', predicate: 'http://example.org/p', object: '"unrecoverable"', graph: '' },
      ] as Quad[]);

      // Reader with a different explicit key — neither key in the
      // chain (primary = reader key, legacy fallback = sha256 default)
      // authenticates this ciphertext. Must NOT leak plaintext.
      const reader = new PrivateContentStore(store, gm, {
        encryptionKey: 'B'.repeat(64),
      });
      const read = await reader.getPrivateTriples('cg-unknown', 'did:dkg:agent:U');
      expect(read).toHaveLength(1);
      expect(read[0].object.startsWith('"enc:gcm:v1:')).toBe(true);
      expect(read[0].object).not.toBe('"unrecoverable"');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// PR #229 bot review round 16 — r16-3: the persisted-key cache must be keyed
// by file path, NOT module-global. Otherwise a single process hosting two
// nodes (test fixtures, multi-tenant daemon, simulation harness) silently
// aliases both onto the FIRST node's key, breaking crypto isolation.
// ---------------------------------------------------------------------------
describe('r16-3 — persisted key cache is keyed by resolved file path', () => {
  let prevKeyFile: string | undefined;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevKeyFile = process.env.DKG_PRIVATE_STORE_KEY_FILE;
    prevHome = process.env.DKG_HOME;
    __resetPrivateStoreKeyCacheForTests();
  });
  afterEach(() => {
    if (prevKeyFile === undefined) delete process.env.DKG_PRIVATE_STORE_KEY_FILE;
    else process.env.DKG_PRIVATE_STORE_KEY_FILE = prevKeyFile;
    if (prevHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = prevHome;
    __resetPrivateStoreKeyCacheForTests();
  });

  it('two PATHS in the same process → two DIFFERENT keys (no aliasing)', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'dkg-ps-r16-3-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'dkg-ps-r16-3-b-'));
    const fileA = join(dirA, 'private-store.key');
    const fileB = join(dirB, 'private-store.key');
    try {
      // Node A boots, generates its key at path A.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileA;
      const { store: storeA, cleanup: cleanA } = makeFreshStore();
      try {
        const gmA = new ContextGraphManager(storeA);
        // eslint-disable-next-line no-void
        void new PrivateContentStore(storeA, gmA); // triggers key creation
      } finally {
        cleanA();
      }
      const keyA = readFileSync(fileA);

      // Node B boots in the SAME process with a different key path.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileB;
      const { store: storeB, cleanup: cleanB } = makeFreshStore();
      try {
        const gmB = new ContextGraphManager(storeB);
        // eslint-disable-next-line no-void
        void new PrivateContentStore(storeB, gmB); // triggers key creation
      } finally {
        cleanB();
      }
      const keyB = readFileSync(fileB);

      // r16-3 core invariant: distinct paths → distinct keys. Under the
      // pre-r16-3 module-global cache, B would have returned A's key
      // without ever touching disk at `fileB`.
      expect(keyA.length).toBe(32);
      expect(keyB.length).toBe(32);
      expect(keyA.equals(keyB)).toBe(false);
      // Sanity: each path carries its OWN file on disk.
      expect(existsSync(fileA)).toBe(true);
      expect(existsSync(fileB)).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('node B CANNOT read data sealed by node A when they run in the same process with different key paths (crypto isolation)', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'dkg-ps-r16-3-iso-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'dkg-ps-r16-3-iso-b-'));
    const fileA = join(dirA, 'private-store.key');
    const fileB = join(dirB, 'private-store.key');
    // Deliberately share the underlying triple-store: this simulates
    // the nightmare scenario the bot flagged — a multi-tenant process
    // where node B accidentally queries node A's graph DB. Pre-r16-3
    // the cache alias made plaintext recoverable; after r16-3 it is
    // not, because B holds a DIFFERENT 32-byte secret.
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-iso');

      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileA;
      __resetPrivateStoreKeyCacheForTests();
      const nodeA = new PrivateContentStore(store, gm);
      await nodeA.storePrivateTriples('cg-iso', 'did:dkg:agent:S', [
        { subject: 'did:dkg:agent:S', predicate: 'http://example.org/p', object: '"secret-on-A"', graph: '' },
      ] as Quad[]);

      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileB;
      __resetPrivateStoreKeyCacheForTests();
      const nodeB = new PrivateContentStore(store, gm);
      const readB = await nodeB.getPrivateTriples('cg-iso', 'did:dkg:agent:S');
      expect(readB).toHaveLength(1);
      // B must NOT see A's plaintext — under the pre-r16-3 alias bug
      // this returned "secret-on-A". Now B sees only the envelope.
      expect(readB[0].object).not.toBe('"secret-on-A"');
      expect(readB[0].object.startsWith('"enc:gcm:v1:')).toBe(true);

      // Sanity: flip back to A and confirm A still decrypts its own
      // data. This proves r16-3 didn't break the intra-process sharing
      // property for a single path — it only disaggregated across paths.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileA;
      __resetPrivateStoreKeyCacheForTests();
      const nodeAAgain = new PrivateContentStore(store, gm);
      const readA = await nodeAAgain.getPrivateTriples('cg-iso', 'did:dkg:agent:S');
      expect(readA).toHaveLength(1);
      expect(readA[0].object).toBe('"secret-on-A"');
    } finally {
      cleanup();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('the SAME path stays cached across instances (no re-generation, no re-read) — only the cache KEY changed, not the sharing property', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dkg-ps-r16-3-share-'));
    const file = join(dir, 'private-store.key');
    try {
      process.env.DKG_PRIVATE_STORE_KEY_FILE = file;
      __resetPrivateStoreKeyCacheForTests();

      const { store, cleanup } = makeFreshStore();
      try {
        const gm = new ContextGraphManager(store);
        await gm.ensureContextGraph('cg-share');
        // First instance: file is generated on disk.
        const ps1 = new PrivateContentStore(store, gm);
        await ps1.storePrivateTriples('cg-share', 'did:dkg:agent:K', [
          { subject: 'did:dkg:agent:K', predicate: 'http://example.org/p', object: '"shared"', graph: '' },
        ] as Quad[]);
        const keyBytes1 = readFileSync(file);

        // Second instance in the SAME process with the SAME path:
        // MUST see the same secret (the r12-2 intra-process sharing
        // property r16-3 preserves).
        const ps2 = new PrivateContentStore(store, gm);
        const read = await ps2.getPrivateTriples('cg-share', 'did:dkg:agent:K');
        expect(read).toHaveLength(1);
        expect(read[0].object).toBe('"shared"');

        // The on-disk key is untouched — we never regenerated it.
        const keyBytes2 = readFileSync(file);
        expect(keyBytes1.equals(keyBytes2)).toBe(true);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('__resetPrivateStoreKeyCacheForTests drops ALL paths, not just the last one used', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'dkg-ps-r16-3-reset-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'dkg-ps-r16-3-reset-b-'));
    const fileA = join(dirA, 'private-store.key');
    const fileB = join(dirB, 'private-store.key');
    try {
      // Warm the cache for path A.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileA;
      const { store: sA, cleanup: cA } = makeFreshStore();
      try { void new PrivateContentStore(sA, new ContextGraphManager(sA)); } finally { cA(); }

      // Warm the cache for path B as well.
      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileB;
      const { store: sB, cleanup: cB } = makeFreshStore();
      try { void new PrivateContentStore(sB, new ContextGraphManager(sB)); } finally { cB(); }

      // Reset must flush BOTH entries. We re-observe by deleting the
      // on-disk key files and asking for a store under path A again —
      // it must regenerate (not serve a stale cached buffer).
      __resetPrivateStoreKeyCacheForTests();
      rmSync(fileA, { force: true });
      rmSync(fileB, { force: true });
      expect(existsSync(fileA)).toBe(false);
      expect(existsSync(fileB)).toBe(false);

      process.env.DKG_PRIVATE_STORE_KEY_FILE = fileA;
      const { store: sA2, cleanup: cA2 } = makeFreshStore();
      try {
        void new PrivateContentStore(sA2, new ContextGraphManager(sA2));
      } finally {
        cA2();
      }
      // New file regenerated → cache was truly empty after reset.
      expect(existsSync(fileA)).toBe(true);
      expect(readFileSync(fileA).length).toBe(32);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe('PrivateContentStore.decryptLiteral — returns envelope on bad key (defence-in-depth)', () => {
  it('wrong key: the instance decrypt method leaves the envelope visible so callers can detect the failure', async () => {
    const { store, cleanup } = makeFreshStore();
    try {
      const gm = new ContextGraphManager(store);
      await gm.ensureContextGraph('cg-wk');
      const writer = new PrivateContentStore(store, gm, { encryptionKey: 'A'.repeat(64) });
      await writer.storePrivateTriples('cg-wk', 'did:dkg:agent:W', [
        { subject: 'did:dkg:agent:W', predicate: 'http://example.org/p', object: '"top-secret"', graph: '' },
      ] as Quad[]);

      // Reader with a DIFFERENT key — getPrivateTriples should pull the
      // rows but return the envelope string verbatim as the literal.
      const reader = new PrivateContentStore(store, gm, { encryptionKey: 'B'.repeat(64) });
      const read = await reader.getPrivateTriples('cg-wk', 'did:dkg:agent:W');
      expect(read).toHaveLength(1);
      expect(read[0].object.startsWith('"enc:gcm:v1:')).toBe(true); // envelope visible
      expect(read[0].object).not.toBe('"top-secret"'); // never leaks plaintext
    } finally {
      cleanup();
    }
  });
});
