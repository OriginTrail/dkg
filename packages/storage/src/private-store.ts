import { assertSafeIri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
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
 *      domain string. This is NOT secret — operators who require real
 *      confidentiality MUST set DKG_PRIVATE_STORE_KEY to a per-deployment
 *      secret. Set `DKG_PRIVATE_STORE_STRICT_KEY=1` (or pass
 *      `strictKey: true` to the constructor) to turn this fallback into
 *      a hard error at startup (bot review N3).
 *
 * We emit a loud console warning the first time the default key is used
 * so the gap is visible in deploy logs even without strict mode.
 */
const DEFAULT_KEY_DOMAIN = 'dkg-v10/private-store/default-key/v1';
let defaultKeyWarned = false;

function strictKeyRequestedFromEnv(): boolean {
  const v = (process.env.DKG_PRIVATE_STORE_STRICT_KEY ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Decode a string-encoded key/passphrase into raw bytes.
 *
 * Bot review N2: previously any non-hex string fell through to
 * `Buffer.from(s, 'base64')`, which silently interprets non-base64 input
 * as truncated garbage. Two callers passing the passphrases `"hunter2"`
 * and `"hunter2!"` would end up with the SAME key because both decode
 * to the same leading bytes under a permissive base64 reader.
 *
 * Resolution:
 *   - 64-char hex → decode as hex.
 *   - Canonical base64 (length multiple of 4, valid alphabet, length >=
 *     44 so the DECODED length is 32 or more) → decode as base64.
 *   - Everything else → treat as a UTF-8 passphrase and SHA-256-stretch.
 */
function decodeKeyOrPassphrase(s: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, 'hex');
  }
  const looksLikeCanonicalBase64 =
    s.length >= 44 &&
    s.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  if (looksLikeCanonicalBase64) {
    try {
      const buf = Buffer.from(s, 'base64');
      if (buf.length >= 32) return buf;
    } catch {
      // fall through to passphrase path
    }
  }
  return Buffer.from(s, 'utf8');
}

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
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    // Strip r6 type-tag prefix (`L|` literal / `I|` IRI). Legacy
    // envelopes without the tag are returned verbatim for backwards
    // compatibility — see `PrivateContentStore#decryptLiteral`.
    if (plain.length >= 2 && plain[1] === '|') return plain.slice(2);
    return plain;
  } catch {
    return serialized;
  }
}

function resolveEncryptionKey(
  explicit?: Uint8Array | string,
  options: { strictKey?: boolean } = {},
): Buffer {
  const fromExplicit = explicit ?? process.env.DKG_PRIVATE_STORE_KEY;
  if (fromExplicit) {
    const buf =
      typeof fromExplicit === 'string'
        ? decodeKeyOrPassphrase(fromExplicit)
        : Buffer.from(fromExplicit);
    if (buf.length !== 32) {
      return createHash('sha256').update(buf).digest();
    }
    return buf;
  }
  // Bot review N3: no key configured. If the caller (or the operator
  // via DKG_PRIVATE_STORE_STRICT_KEY) has opted into strict mode, refuse
  // to fall back to the public default — any private data encrypted
  // under the default key is essentially plaintext for anyone with the
  // repo source.
  const strict = options.strictKey ?? strictKeyRequestedFromEnv();
  if (strict) {
    throw new Error(
      'PrivateContentStore strict mode: DKG_PRIVATE_STORE_KEY is not set ' +
        'and no encryptionKey was supplied. Refusing to fall back to the ' +
        'process-wide default key — any private triples written under it ' +
        'would be decryptable by anyone with repo access.',
    );
  }
  if (!defaultKeyWarned) {
    defaultKeyWarned = true;
    // Loud warning on stderr so it survives log-level filtering.
    console.warn(
      '[PrivateContentStore] WARNING: DKG_PRIVATE_STORE_KEY is not set. ' +
        'Falling back to a deterministic default key derived from a public ' +
        'constant — private triples encrypted under this key are NOT ' +
        'confidential against anyone with access to this repository. Set ' +
        'DKG_PRIVATE_STORE_KEY to a per-deployment secret, or set ' +
        'DKG_PRIVATE_STORE_STRICT_KEY=1 to turn this fallback into an error.',
    );
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
    options: { encryptionKey?: Uint8Array | string; strictKey?: boolean } = {},
  ) {
    this.store = store;
    this.graphManager = graphManager;
    this.encryptionKey = resolveEncryptionKey(options.encryptionKey, {
      strictKey: options.strictKey,
    });
  }

  /**
   * AES-256-GCM seal — operates on the LEXICAL value portion of an
   * RDF literal so the wire and at-rest formats remain valid N-Quads
   * (a quoted string with no datatype/language). The wrapper preserves
   * the original literal shape (language tag / datatype IRI) by
   * embedding it in the plaintext payload before encryption.
   *
   * Bot review N1: the previous implementation derived the IV as
   * HMAC-SHA256(key, plaintext) truncated to 96 bits. That is NOT RFC
   * 8452 AES-GCM-SIV; it is plain AES-GCM with a deterministic IV. Two
   * identical plaintexts sealed under the same key produce identical
   * 96-bit IVs, which is exactly the condition AES-GCM forbids — a
   * single same-key same-nonce collision on two distinct plaintexts
   * leaks H (the authentication subkey) and lets an attacker forge
   * arbitrary tags. Even without two distinct plaintexts, determinism
   * itself is a confidentiality leak: identical plaintexts become
   * identical ciphertexts, which is visible at the storage layer.
   *
   * We now draw a fresh 96-bit random IV for every seal. The downstream
   * dedup pipeline (async-lift `subtractFinalizedExactQuads`) already
   * decrypts via {@link decryptPrivateLiteral} before comparing, so
   * non-deterministic ciphertext does not break it.
   */
  private encryptLiteral(serialized: string): string {
    // Blank nodes are node-local and carry no externally-meaningful
    // identity, so sealing them would only break dedup — leave as-is.
    if (serialized.startsWith('_:')) return serialized;
    // Seal IRI objects in the SAME envelope as literals (PR #229 bot
    // review round 6 — IRI objects leaking from private graphs). Prior
    // to this fix `encryptLiteral` only wrapped values starting with `"`
    // and passed IRI objects through unchanged, so the N-Quads dump of
    // a private graph leaked every outgoing edge's target IRI (e.g.
    // `ex:ssn`, `http://foo/creditCard`). We mark the wrapped term with
    // an extra `TAG|` byte inside the ciphertext so the decrypt side
    // can restore the original term shape (IRI vs literal vs blank).
    //
    // Tag values:
    //   L = original term was a literal (starts with `"`)
    //   I = original term was an IRI (anything else non-blank)
    //
    // The outer envelope is always a valid N-Triples literal so the
    // underlying TripleStore stays syntactically happy regardless of
    // the original term kind.
    const tag = serialized.startsWith('"') ? 'L' : 'I';
    const plaintext = `${tag}|${serialized}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ct = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, authTag, ct]).toString('base64');
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
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      // Legacy (pre-r6) envelopes contained the literal bytes verbatim
      // with no type tag. Detect them by the absence of the `L|` / `I|`
      // prefix and return them unchanged so previously-written data
      // stays readable after the seal-IRI upgrade.
      if (plain.length < 2 || plain[1] !== '|') return plain;
      return plain.slice(2);
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
