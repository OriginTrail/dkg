import { assertSafeIri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import type { TripleStore, Quad } from './triple-store.js';
import type { ContextGraphManager } from './graph-manager.js';

/**
 * Manages private (publisher-only) triples. These live in the same context
 * graph data graph as public triples, but are only stored on the publisher's
 * node. The meta graph records which KAs have private triples (via
 * privateMerkleRoot and privateTripleCount).
 */
/** AES-GCM ciphertext envelope tag — distinguishes private literals
 *  from any other typed/plain literal that happens to look like
 *  base64. Versioned so the on-disk format can rotate without
 *  breaking existing data. */
const ENC_PREFIX = 'enc:gcm:v1:';

/** Encryption key resolution order:
 *   1. Explicit constructor `encryptionKey` (32 bytes, hex/base64/raw or
 *      shorter passphrase — short inputs are SHA-256-stretched so AES-256
 *      always sees a full 256-bit key).
 *   2. `DKG_PRIVATE_STORE_KEY` env var (same shape as #1).
 *   3. A deterministic process-wide default derived from a constant
 *      domain string. This is NOT secret — it serves three goals:
 *        (a) on-disk N-Quads dumps no longer contain plaintext (ST-2);
 *        (b) every PrivateContentStore in the same process produces
 *            identical ciphertext for identical plaintext, which keeps
 *            equality-based subtraction/dedup pipelines functional
 *            (e.g. async-lift `subtractFinalizedExactQuads`); and
 *        (c) a separate node operator who has not configured
 *            DKG_PRIVATE_STORE_KEY can still round-trip private data.
 *      Operators who require real confidentiality MUST set
 *      DKG_PRIVATE_STORE_KEY to a per-deployment secret.
 */
const DEFAULT_KEY_DOMAIN = 'dkg-v10/private-store/default-key/v1';

/**
 * Stateless mirror of {@link PrivateContentStore}'s seal — used by
 * pipelines that read private quads back from the underlying store via
 * raw SPARQL (and therefore see ciphertext envelopes) but want to
 * reason about plaintext semantics. Examples include the publisher's
 * `subtractFinalizedExactQuads`, which compares input plaintext quads
 * against on-disk authoritative quads for exact dedup. Without this,
 * the subtraction silently misses every private match because
 * `"plaintext"` never equals `"enc:gcm:v1:…"`.
 *
 * The helper resolves the same encryption key (DKG_PRIVATE_STORE_KEY
 * or the deterministic default-domain hash) so every consumer in the
 * process round-trips to identical bytes. Non-encrypted literals,
 * URIs, and blank nodes are returned unchanged.
 */
export function decryptPrivateLiteral(
  serialized: string,
  options: { encryptionKey?: Uint8Array | string } = {},
): string {
  if (!serialized.startsWith(`"${ENC_PREFIX}`)) return serialized;
  const m = serialized.match(/^"enc:gcm:v1:([^"]+)"$/);
  if (!m) return serialized;
  const key = resolveEncryptionKey(options.encryptionKey);
  try {
    const buf = Buffer.from(m[1], 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return serialized;
  }
}

function resolveEncryptionKey(explicit?: Uint8Array | string): Buffer {
  const fromExplicit = explicit ?? process.env.DKG_PRIVATE_STORE_KEY;
  if (fromExplicit) {
    const buf =
      typeof fromExplicit === 'string'
        ? /^[0-9a-fA-F]{64}$/.test(fromExplicit)
          ? Buffer.from(fromExplicit, 'hex')
          : Buffer.from(fromExplicit, 'base64')
        : Buffer.from(fromExplicit);
    if (buf.length !== 32) {
      return createHash('sha256').update(buf).digest();
    }
    return buf;
  }
  return createHash('sha256').update(DEFAULT_KEY_DOMAIN).digest();
}

export class PrivateContentStore {
  private readonly store: TripleStore;
  private readonly graphManager: ContextGraphManager;
  /** Tracks which rootEntities have private triples on this node. */
  private readonly privateEntities = new Map<string, Set<string>>();
  /** AES-256-GCM key — used to seal literal objects of private quads
   *  before they reach the underlying TripleStore (BUGS_FOUND.md ST-2). */
  private readonly encryptionKey: Buffer;

  constructor(
    store: TripleStore,
    graphManager: ContextGraphManager,
    options: { encryptionKey?: Uint8Array | string } = {},
  ) {
    this.store = store;
    this.graphManager = graphManager;
    this.encryptionKey = resolveEncryptionKey(options.encryptionKey);
  }

  /**
   * AES-256-GCM seal — operates on the LEXICAL value portion of an
   * RDF literal so the wire and at-rest formats remain valid N-Quads
   * (a quoted string with no datatype/language). The wrapper preserves
   * the original literal shape (language tag / datatype IRI) by
   * embedding it in the plaintext payload before encryption.
   */
  private encryptLiteral(serialized: string): string {
    if (!serialized.startsWith('"')) return serialized;
    // Deterministic IV: HMAC-SHA256(key, plaintext) truncated to 96 bits.
    // This is the AES-GCM-SIV pattern — different plaintexts yield
    // different IVs (collision probability negligible at 96 bits) so
    // GCM's nonce-misuse hazard does not apply, while identical
    // plaintexts produce identical ciphertexts. Equality-based
    // dedup/subtraction (e.g. publisher async-lift
    // `subtractFinalizedExactQuads`) therefore continues to work
    // without a decryption pass and ST-2 at-rest confidentiality is
    // preserved (the on-disk envelope never contains the plaintext).
    const iv = createHmac('sha256', this.encryptionKey)
      .update(serialized, 'utf8')
      .digest()
      .subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ct = Buffer.concat([
      cipher.update(serialized, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ct]).toString('base64');
    return `"${ENC_PREFIX}${payload}"`;
  }

  private decryptLiteral(serialized: string): string {
    if (!serialized.startsWith(`"${ENC_PREFIX}`)) return serialized;
    const m = serialized.match(/^"enc:gcm:v1:([^"]+)"$/);
    if (!m) return serialized;
    try {
      const buf = Buffer.from(m[1], 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const ct = buf.subarray(28);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        iv,
      );
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      return plain.toString('utf8');
    } catch {
      // Wrong key or corrupted ciphertext — leave the envelope visible
      // so callers can detect the failure rather than silently dropping
      // to "no result".
      return serialized;
    }
  }

  clearCache(key: string): void {
    this.privateEntities.delete(key);
  }

  private privateGraph(contextGraphId: string, subGraphName?: string): string {
    return subGraphName
      ? this.graphManager.subGraphPrivateUri(contextGraphId, subGraphName)
      : this.graphManager.privateGraphUri(contextGraphId);
  }

  private privateKey(contextGraphId: string, subGraphName?: string): string {
    return subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
  }

  async storePrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    quads: Quad[],
    subGraphName?: string,
  ): Promise<void> {
    if (quads.length === 0) return;

    // ST-7 defence-in-depth: reject unsafe rootEntity at the entry point so
    // malformed IRIs never reach the in-memory tracker. Without this, a
    // subsequent hasPrivate/getPrivate/delete call against the same key
    // either crashes or attempts to build a SPARQL query containing the
    // smuggled payload.
    assertSafeIri(rootEntity);

    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    // ST-2: encrypt the literal `object` BEFORE handing the quad to the
    // underlying TripleStore. URIs and blank nodes carry no payload and
    // are passed through unchanged. The resulting on-disk N-Quads dump
    // contains only ciphertext envelopes (`enc:gcm:v1:<base64>`),
    // satisfying the BUGS_FOUND.md ST-2 invariant. Callers retrieve
    // plaintext via `getPrivateTriples`, which reverses the seal.
    const normalized = quads.map((q) => ({
      ...q,
      object: this.encryptLiteral(q.object),
      graph: graphUri,
    }));
    await this.store.insert(normalized);

    const key = this.privateKey(contextGraphId, subGraphName);
    let entities = this.privateEntities.get(key);
    if (!entities) {
      entities = new Set();
      this.privateEntities.set(key, entities);
    }
    entities.add(rootEntity);
  }

  async getPrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    const sparql = `
      SELECT ?s ?p ?o WHERE {
        GRAPH <${assertSafeIri(graphUri)}> {
          ?s ?p ?o .
          FILTER(
            ?s = <${assertSafeIri(rootEntity)}>
            || STRSTARTS(STR(?s), "${escapeSparqlLiteral(rootEntity)}/.well-known/genid/")
          )
        }
      }
    `;
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings') return [];

    return result.bindings.map((row) => ({
      subject: row['s'],
      predicate: row['p'],
      // Reverse the AES-GCM seal applied at write time so callers see
      // the original literal value (BUGS_FOUND.md ST-2). Non-encrypted
      // values (legacy data, URIs, blank nodes) flow through unchanged.
      object: this.decryptLiteral(row['o']),
      graph: graphUri,
    }));
  }

  hasPrivateTriples(contextGraphId: string, rootEntity: string, subGraphName?: string): boolean {
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    return entities?.has(rootEntity) ?? false;
  }

  /**
   * Checks the store directly for whether private triples exist.
   * Useful when the in-memory tracker hasn't been populated (e.g., on a
   * different instance than the one that originally stored the triples).
   */
  async hasPrivateTriplesInStore(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<boolean> {
    const quads = await this.getPrivateTriples(contextGraphId, rootEntity, subGraphName);
    return quads.length > 0;
  }

  async deletePrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<void> {
    // ST-7: assertSafeIri on the delete path so a malicious rootEntity
    // cannot smuggle SPARQL-update tokens into `deleteBySubjectPrefix`.
    assertSafeIri(rootEntity);
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    await this.store.deleteBySubjectPrefix(graphUri, rootEntity);
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    if (entities) entities.delete(rootEntity);
  }
}
