import { assertSafeIri, escapeSparqlLiteral, isSafeIri } from '@origintrail-official/dkg-core';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
 *   3. A **per-node persisted** key generated at first run and stored on
 *      disk with 0600 permissions. The path resolves in this order:
 *        a. `DKG_PRIVATE_STORE_KEY_FILE`
 *        b. `<DKG_HOME>/private-store.key`
 *        c. `<homedir()>/.dkg/private-store.key`
 *      If any directory in the chain is unwritable we fall through to
 *      step 4 rather than silently crashing.
 *   4. As a last resort a deterministic `sha256(DEFAULT_KEY_DOMAIN)` —
 *      which is NOT secret and has to be kept behind a loud warning
 *      for environments (e.g. read-only FS, sandboxed CI) where
 *      persisting a key is impossible. Operators who need guaranteed
 *      confidentiality even in those environments MUST configure
 *      `DKG_PRIVATE_STORE_KEY` explicitly or turn on strict mode via
 *      `DKG_PRIVATE_STORE_STRICT_KEY=1` (or `strictKey: true`), which
 *      turns step 4 into a hard error.
 *
 * behaviour: step 3 did not exist, so every node without an
 * explicit key shared `sha256(DEFAULT_KEY_DOMAIN)` — any attacker with
 * repo source could decrypt the stored "private" triples across the
 * whole fleet.
 */
const DEFAULT_KEY_DOMAIN = 'dkg-v10/private-store/default-key/v1';
const PERSISTED_KEY_FILENAME = 'private-store.key';
let defaultKeyWarned = false;
/**
 * Per-path cache of persisted keys. An earlier revision used a
 * single module-global `cachedPersistedKey: Buffer | null`, which
 * silently aliased multiple `PrivateContentStore` instances onto
 * the FIRST node's key whenever one process hosted several nodes
 * with different `DKG_HOME` / `DKG_PRIVATE_STORE_KEY_FILE` values
 * (test fixtures, multi-tenant daemons, simulation harnesses).
 * The second node would:
 *   1. call `resolvePersistedKeyPath()` → get its OWN path
 *   2. call `loadOrCreatePersistedKey()` → hit the module-global
 *      cache populated by node #1, return node #1's key
 *   3. read/write all private data under node #1's secret, breaking
 *      crypto isolation.
 * When the env later flipped back to the original path, cached key
 * still won and data became unreadable.
 *
 * Fix: key the cache by resolved file path. Each node's path maps
 * to its own key buffer. Writes to the same path still hit the
 * cache (the round-12-2 intra-process sharing property). Different
 * paths get different keys.
 *
 * The cache is still process-local, unbounded-by-design (the set
 * of paths a single process opens in its lifetime is inherently
 * bounded by the number of node instances it hosts — this is
 * thousands at most, not millions of entries). A hostile caller
 * that spins up a new path every call would still be bounded by
 * the filesystem's own limits long before the Map becomes a
 * memory issue.
 */
let persistedKeyWarnedPaths: Set<string> = new Set();
const persistedKeyByPath: Map<string, Buffer> = new Map();

function strictKeyRequestedFromEnv(): boolean {
  const v = (process.env.DKG_PRIVATE_STORE_STRICT_KEY ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function resolvePersistedKeyPath(): string {
  if (process.env.DKG_PRIVATE_STORE_KEY_FILE) {
    return process.env.DKG_PRIVATE_STORE_KEY_FILE;
  }
  if (process.env.DKG_HOME) {
    return join(process.env.DKG_HOME, PERSISTED_KEY_FILENAME);
  }
  return join(homedir(), '.dkg', PERSISTED_KEY_FILENAME);
}

/**
 * Load the per-node persisted key, generating it on first run.
 *
 * Returns `null` if we cannot read or create the key file (read-only
 * filesystem, unknown home directory, etc.) so the caller can fall
 * through to the deterministic last-resort key under a loud warning.
 *
 * Failure modes we deliberately tolerate:
 *   - file exists but is shorter than 32 bytes: treat as corrupt,
 *     regenerate (we never want a short AES-256 key).
 *   - dir doesn't exist: `mkdirSync(..., recursive: true)`.
 *   - write errors: fall through to last-resort key.
 *
 * The cached key is process-wide so multiple `PrivateContentStore`
 * instances on the same node share the same secret without re-reading
 * the file on every construction.
 */
function loadOrCreatePersistedKey(): Buffer | null {
  const path = resolvePersistedKeyPath();
  // per-path cache, so two nodes in the same process with
  // different key files each get THEIR OWN key.
  const cached = persistedKeyByPath.get(path);
  if (cached) return cached;

  // private-store.ts:124). The
  // previous logic had two correctness holes around persistent key
  // loading:
  //
  //   1. If the key file existed but was SHORT (<32 bytes — truncated,
  //      partial write, FS corruption), the `if (raw.length >= 32)`
  //      branch silently fell through to the regenerate path below.
  //      That auto-rotation re-keys the node in place AND overwrites
  //      the original (possibly recoverable) bytes — every previously
  //      encrypted private triple is silently stranded with no way for
  //      the operator to notice.
  //
  //   2. The outer `try/catch` swallowed ALL errors (including
  //      "permission denied", "file is a symlink to /dev/null", etc.)
  //      and returned `null` so the caller fell back to the global
  //      deterministic last-resort key. That's a different but related
  //      stranding: future writes encrypt under last-resort, while
  //      reads of pre-existing data still need the persisted key, and
  //      neither side surfaces the problem.
  //
  // Fix: TREAT A NON-EMPTY-BUT-INVALID FILE AS A LOUD ERROR. Only
  // generate a fresh key when the file is genuinely absent. If the
  // file exists but is short, throw a clear `Error` so the operator
  // sees the corruption signal at startup. The `DKG_PRIVATE_STORE_KEY`
  // / `DKG_PRIVATE_STORE_KEY_FILE` env overrides remain available as
  // an escape hatch for managed-secret deployments. An optional
  // `DKG_PRIVATE_STORE_KEY_AUTO_RESET=1` lets the operator opt back
  // into the old auto-regenerate behaviour after they've explicitly
  // accepted the data-loss trade-off.
  const fileExists = existsSync(path);
  if (fileExists) {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (err) {
      // Read failed entirely (permissions, symlink loop, etc.) —
      // surface the OS error so the operator can fix it instead of
      // silently re-keying the node.
      throw new Error(
        `[PrivateContentStore] Failed to read persistent private-store key file at ${path}: ` +
          `${(err as Error).message}. Refusing to fall back to a fresh key (would silently strand existing private triples). ` +
          'Fix the file, restore from backup, set DKG_PRIVATE_STORE_KEY / DKG_PRIVATE_STORE_KEY_FILE, ' +
          'or set DKG_PRIVATE_STORE_KEY_AUTO_RESET=1 if you accept losing every previously encrypted private triple.',
        { cause: err as Error },
      );
    }
    if (raw.length >= 32) {
      const key = Buffer.from(raw.subarray(0, 32));
      persistedKeyByPath.set(path, key);
      return key;
    }
    // File exists but is unusable. Loud error — see commentary above.
    if (process.env.DKG_PRIVATE_STORE_KEY_AUTO_RESET === '1') {
      console.warn(
        `[PrivateContentStore] Persistent private-store key file at ${path} is corrupt ` +
          `(length=${raw.length}, expected >= 32). DKG_PRIVATE_STORE_KEY_AUTO_RESET=1 is set, ` +
          'so a FRESH key will be generated. Every previously encrypted private triple under the old ' +
          'key is now PERMANENTLY UNRECOVERABLE.',
      );
      // Fall through to the generation path below.
    } else {
      throw new Error(
        `[PrivateContentStore] Persistent private-store key file at ${path} is corrupt ` +
          `(length=${raw.length}, expected >= 32 bytes for AES-256). ` +
          'Refusing to auto-regenerate (would silently strand every previously encrypted private triple). ' +
          'Restore the file from backup, set DKG_PRIVATE_STORE_KEY / DKG_PRIVATE_STORE_KEY_FILE to a known-good secret, ' +
          'or set DKG_PRIVATE_STORE_KEY_AUTO_RESET=1 to accept losing every previously encrypted private triple ' +
          'and regenerate a fresh key on next start.',
      );
    }
  }

  // First-run path: file is genuinely absent (or auto-reset opted-in).
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh = randomBytes(32);
    writeFileSync(path, fresh, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* non-POSIX FS */ }
    if (!persistedKeyWarnedPaths.has(path)) {
      persistedKeyWarnedPaths.add(path);
      console.warn(
        `[PrivateContentStore] Generated per-node private-store key at ${path}. ` +
          'Back this file up alongside your node data; losing it makes existing ' +
          'private triples unrecoverable. Override with DKG_PRIVATE_STORE_KEY ' +
          'or DKG_PRIVATE_STORE_KEY_FILE to use a managed secret instead.',
      );
    }
    persistedKeyByPath.set(path, fresh);
    return fresh;
  } catch {
    // Generation failed (read-only FS, unknown home, etc.). Caller
    // falls through to the deterministic last-resort key under a loud
    // warning — same behaviour as before this change. We deliberately
    // do NOT throw here because some test/dev environments cannot
    // create the file at all and the operator already accepted the
    // last-resort fallback in those topologies.
    return null;
  }
}

/** Test-only: drop any cached per-node key so a subsequent call
 *  re-reads from the (possibly-changed) persistence path. */
export function __resetPrivateStoreKeyCacheForTests(): void {
  persistedKeyByPath.clear();
  defaultKeyWarned = false;
  persistedKeyWarnedPaths = new Set();
}

/**
 * Decode a string-encoded key/passphrase into raw bytes.
 *
 * previously any non-hex string fell through to
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
 * Compute the deterministic legacy fallback key.
 *
 * nodes (no `DKG_PRIVATE_STORE_KEY` configured) all shared
 * `sha256(DEFAULT_KEY_DOMAIN)`. the rightly stopped using
 * that as the preferred key, but a straight flip would strand every
 * private triple written before the upgrade — the fresh per-node key
 * cannot decrypt ciphertext sealed under the deterministic key.
 *
 * keep the legacy key around as
 * a **decrypt-only** fallback so existing data remains readable after
 * upgrade. New writes always use the primary key. The legacy key is
 * never used to encrypt anything (the confidentiality regression that
 * ed is preserved — no one sharing a public constant for
 * fresh data). Once all legacy ciphertext has been re-encrypted or
 * deleted, operators can drop the fallback entirely by setting
 * `DKG_PRIVATE_STORE_STRICT_KEY=1` (which disables unconfigured-key
 * fallbacks altogether).
 */
function computeLegacyDefaultDomainKey(): Buffer {
  return createHash('sha256').update(DEFAULT_KEY_DOMAIN).digest();
}

/**
 * Try to decrypt an AES-GCM envelope against a primary key, falling
 * back to a list of legacy keys if the primary fails.
 *
 * AES-GCM authenticates every ciphertext with a 128-bit tag, so a
 * wrong key surfaces as a `decipher.final()` throw (Error: Unsupported
 * state or unable to authenticate data) — no silent plaintext
 * corruption. That lets us safely try keys in order and return the
 * first that authenticates.
 *
 * Returns `null` if NO key in the chain authenticates the ciphertext;
 * callers turn that into "leave the envelope visible so the operator
 * can detect the failure".
 */
function tryDecryptWithKeyChain(
  iv: Buffer,
  tag: Buffer,
  ct: Buffer,
  primary: Buffer,
  legacyKeys: readonly Buffer[],
): string | null {
  const chain = [primary, ...legacyKeys];
  for (const key of chain) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      // try next key
    }
  }
  return null;
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
 *
 * when the primary key can't
 * decrypt (typical on nodes just upgraded past r12-2 that still hold
 * private triples sealed under the legacy default-domain
 * key), fall back to the legacy `sha256(DEFAULT_KEY_DOMAIN)` key so
 * old data remains readable.
 */
export function decryptPrivateLiteral(
  serialized: string,
  options: { encryptionKey?: Uint8Array | string } = {},
): string {
  if (!serialized.startsWith(`"${ENC_PREFIX}`)) return serialized;
  const m = serialized.match(/^"enc:gcm:v1:([^"]+)"$/);
  if (!m) return serialized;
  const primary = resolveEncryptionKey(options.encryptionKey);
  const legacyKeys = resolveLegacyDecryptionKeys(primary);
  try {
    const buf = Buffer.from(m[1], 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const plain = tryDecryptWithKeyChain(Buffer.from(iv), Buffer.from(tag), Buffer.from(ct), primary, legacyKeys);
    if (plain === null) return serialized;
    // Strip r6 type-tag prefix (`L|` literal / `I|` IRI). Legacy
    // envelopes without the tag are returned verbatim for backwards
    // compatibility — see `PrivateContentStore#decryptLiteral`.
    if (plain.length >= 2 && plain[1] === '|') return plain.slice(2);
    return plain;
  } catch {
    return serialized;
  }
}

/**
 * Build the decrypt-only fallback-key list.
 *
 * Rules:
 *   - Always include `sha256(DEFAULT_KEY_DOMAIN)` unless it IS the
 *     primary (no point trying the same key twice — and that happens
 *     naturally on a read-only/sandbox node whose persisted-key
 *     creation failed and fell through to the legacy last-resort key
 *     anyway).
 *   - Never return an entry that would encrypt. This list is consumed
 *     by `tryDecryptWithKeyChain` only.
 */
function resolveLegacyDecryptionKeys(primary: Buffer): Buffer[] {
  const legacy = computeLegacyDefaultDomainKey();
  if (primary.equals(legacy)) return [];
  return [legacy];
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
  // no key configured. If the caller (or the
  // operator via DKG_PRIVATE_STORE_STRICT_KEY) has opted into strict
  // mode, refuse to fall back to ANY unconfigured key — strict callers
  // want a managed secret or nothing at all.
  const strict = options.strictKey ?? strictKeyRequestedFromEnv();
  if (strict) {
    throw new Error(
      'PrivateContentStore strict mode: DKG_PRIVATE_STORE_KEY is not set ' +
        'and no encryptionKey was supplied. Refusing to fall back to an ' +
        'auto-generated per-node key or the deterministic default — ' +
        'configure a managed secret explicitly.',
    );
  }
  // Preferred default: per-node persisted
  // key. This gives every unconfigured node a unique secret so
  // "private" triples are not cross-decryptable across the fleet.
  const persisted = loadOrCreatePersistedKey();
  if (persisted) return persisted;
  // Last resort — persistence failed (read-only FS / CI sandbox / no
  // HOME). Emit a LOUD warning so the operator can see the gap and
  // either configure DKG_PRIVATE_STORE_KEY or make the key path
  // writable. Private triples written under this key are NOT
  // confidential against anyone with repo access.
  if (!defaultKeyWarned) {
    defaultKeyWarned = true;
    console.warn(
      '[PrivateContentStore] WARNING: DKG_PRIVATE_STORE_KEY is not set ' +
        'and the per-node key file could not be created ' +
        `(${resolvePersistedKeyPath()}). Falling back to a deterministic ` +
        'default key derived from a public constant — private triples ' +
        'encrypted under this key are NOT confidential against anyone ' +
        'with access to this repository. Set DKG_PRIVATE_STORE_KEY to a ' +
        'per-deployment secret, set DKG_PRIVATE_STORE_KEY_FILE to a ' +
        'writable path, or set DKG_PRIVATE_STORE_STRICT_KEY=1 to turn ' +
        'this fallback into an error.',
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
   *  before they reach the underlying TripleStore (. */
  private readonly encryptionKey: Buffer;
  /**
   * dedup race). The
   * read-then-insert sequence in {@link storePrivateTriples} would,
   * under concurrent invocation for the same private graph, let two
   * writers both observe an empty `existingPlainKeys`, then each
   * insert their own ciphertext for the SAME `(s,p,o)` plaintext.
   * Because {@link encryptLiteral} now uses a fresh random IV per
   * call, the two ciphertexts are byte-distinct, so
   * the underlying triple store happily keeps both — duplicating the
   * private quad. This map serialises `storePrivateTriples` calls per
   * `graphUri` so the read-and-insert pair is atomic from the caller's
   * perspective. Different graphs still write in parallel.
   */
  private readonly perGraphWriteLocks = new Map<string, Promise<void>>();

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
   * Run `fn` while holding an exclusive lock on `graphUri`. The lock
   * is released when `fn` resolves OR rejects; queued waiters then
   * fire in order.
   *
   * private-store.ts:491). The lock chain
   * MUST decouple from the predecessor's success/failure: pre-r31-14
   * the chain was `prev.then(() => next)` and `await prev` was
   * outside the try/finally. If any prior writer rejected, `prev`
   * was a rejected promise — every subsequent waiter inherited the
   * rejection on `await prev` BEFORE entering the try{} that calls
   * `release()`. That left `next` pending forever, the in-flight
   * `chained` rejected, and the `perGraphWriteLocks` entry was never
   * cleaned up because the cleanup also sat in the `finally`. Net
   * effect: a single failed `storePrivateTriples()` permanently
   * BRICKED that graph until process restart — every later writer
   * for the same graph either threw on the rejected predecessor
   * before doing anything OR enqueued behind a permanently-pending
   * `next`.
   *
   * Fix: build the chain off `prev.catch(() => {})` so the queue is
   * resilient to a predecessor's rejection. The lock is purely a
   * mutex over `fn()`; the success/failure of the previous writer's
   * own `fn()` is its caller's concern, not the queue's. Also
   * `await safePrev` (the catch-wrapped variant) so the wait can
   * never throw before we register the cleanup-on-finally.
   */
  private async withGraphWriteLock<T>(
    graphUri: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.perGraphWriteLocks.get(graphUri) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    // Swallow predecessor rejections so the queue keeps draining.
    // The previous writer's caller already saw (or chose to ignore)
    // the rejection; the lock has no business re-throwing here.
    const safePrev = prev.catch(() => undefined);
    const chained = safePrev.then(() => next);
    this.perGraphWriteLocks.set(graphUri, chained);
    await safePrev;
    try {
      return await fn();
    } finally {
      release();
      if (this.perGraphWriteLocks.get(graphUri) === chained) {
        this.perGraphWriteLocks.delete(graphUri);
      }
    }
  }

  /**
   * AES-256-GCM seal — operates on the LEXICAL value portion of an
   * RDF literal so the wire and at-rest formats remain valid N-Quads
   * (a quoted string with no datatype/language). The wrapper preserves
   * the original literal shape (language tag / datatype IRI) by
   * embedding it in the plaintext payload before encryption.
   *
   * the previous implementation derived the IV as
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
    // Seal IRI objects in the SAME envelope as literals: an earlier
    // revision had `encryptLiteral` only wrap values starting with
    // `"` and pass IRI objects through unchanged, so the N-Quads
    // dump of a private graph leaked every outgoing edge's target
    // IRI (e.g. `ex:ssn`, `http://foo/creditCard`). We mark the
    // wrapped term with
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
      // fall back to the legacy
      // `sha256(DEFAULT_KEY_DOMAIN)` key when the primary key fails
      // to authenticate. This is decrypt-only — `encryptLiteral`
      // always uses `this.encryptionKey` — so a freshly-upgraded node
      // whose private triples were sealed under the legacy
      // deterministic key can still read them, while every new write
      // goes to the unique per-node key.
      const legacyKeys = resolveLegacyDecryptionKeys(this.encryptionKey);
      const plain = tryDecryptWithKeyChain(
        Buffer.from(iv),
        Buffer.from(tag),
        Buffer.from(ct),
        this.encryptionKey,
        legacyKeys,
      );
      if (plain === null) {
        // Wrong key or corrupted ciphertext — leave the envelope
        // visible so callers can detect the failure rather than
        // silently dropping to "no result".
        return serialized;
      }
      // Legacy (pre-r6) envelopes contained the literal bytes verbatim
      // with no type tag. Detect them by the absence of the `L|` / `I|`
      // prefix and return them unchanged so previously-written data
      // stays readable after the seal-IRI upgrade.
      if (plain.length < 2 || plain[1] !== '|') return plain;
      return plain.slice(2);
    } catch {
      return serialized;
    }
  }

  /**
   * Read the set of already-present `(s, p, plaintextObject)` triples in
   * `graphUri` whose `(s, p)` appears in `incoming`, decrypting the
   * stored ciphertext objects so comparison is on plaintext identity.
   *
   * Scoping the SPARQL to only the `(s, p)` pairs the caller is about
   * to write keeps this bounded: the naive "pull every private quad in
   * the graph" variant would be O(|graph|) per insert.
   */
  private async collectExistingPlaintextKeys(
    graphUri: string,
    incoming: Quad[],
  ): Promise<Set<string>> {
    const subjects = new Set<string>();
    const predicates = new Set<string>();
    for (const q of incoming) {
      subjects.add(q.subject);
      predicates.add(q.predicate);
    }
    if (subjects.size === 0 || predicates.size === 0) return new Set();

    // — private-store.ts:553). The
    // dedup query previously assumed every subject was an IRI and
    // ran `assertSafeIri()` over each — but private RDF can legally
    // contain blank-node subjects (`_:b0`) and `assertSafeIri()`
    // throws on them. That throw escaped the surrounding try/catch
    // (which only wraps `this.store.query(sparql)`, not the SPARQL
    // construction), so a single blank-node-subject quad anywhere
    // in the batch failed `storePrivateTriples()` outright instead
    // of letting it fall back to the no-dedup path.
    //
    // Two complications govern the fix:
    //   1. `assertSafeIri()` on `predicate` is FINE — RDF predicates
    //      MUST be IRIs, never blank nodes. So we keep that strict.
    //   2. Blank node IDENTITY is not stable across SPARQL queries
    //      in the general case (a `_:b0` literal in a fresh query
    //      may or may not bind to the same store-internal blank
    //      node, depending on the implementation). So we cannot
    //      rely on `VALUES ?s { _:b0 }` to dedup correctly even if
    //      the parser accepted it. Instead, we OMIT the `?s VALUES`
    //      pin entirely whenever ANY incoming subject is non-IRI
    //      and rely on the predicate VALUES (always IRIs) +
    //      post-filter to bound the working set. Predicate VALUES
    //      alone is still a dramatic narrowing vs reading the
    //      entire private graph; a private graph that uses the
    //      same predicate for thousands of subjects already pays
    //      that scan in `getPrivateTriples()`.
    //   3. The post-filter still pre-computes the
    //      `subject\u0001predicate\u0001plain` key BEFORE inserting
    //      into the dedup set, so a blank-node subject in the
    //      store still dedups against the SAME blank-node label in
    //      the incoming batch — which is exactly the contract we
    //      want for retry idempotency (the same caller writing the
    //      same `_:b0` twice).
    let escapedPredicateVals: string;
    try {
      escapedPredicateVals = [...predicates]
        .map((p) => `<${assertSafeIri(p)}>`)
        .join(' ');
    } catch {
      // Predicate that fails `assertSafeIri` is malformed RDF; bail
      // to no-dedup rather than throwing out of an idempotency
      // helper.
      return new Set();
    }

    let escapedGraph: string;
    try {
      escapedGraph = `<${assertSafeIri(graphUri)}>`;
    } catch {
      // graphUri is constructed by the privateGraph() helper from
      // contextGraphId + subGraphName — both already validated
      // upstream — so this catch is purely defence-in-depth.
      return new Set();
    }

    const incomingSubjects = [...subjects];
    // — private-store.ts:553) — note on
    // detection. `assertSafeIri()` only rejects characters that would
    // break SPARQL `<...>` framing; it accepts strings like `_:bn`
    // because `_` and `:` aren't unsafe glyphs. That meant a previous
    // attempt at this fix (gating on `assertSafeIri()` not throwing)
    // still emitted invalid `<_:bn>` IRI tokens for blank-node
    // subjects, the SPARQL parser rejected the query, and dedup
    // silently fell back to no-op for ALL mixed batches — including
    // the IRI subjects that should still have deduped. We now use the
    // strict `isSafeIri()` check, which requires a `scheme:` prefix
    // (and so reliably distinguishes IRIs from blank nodes / literals
    // that happen to be character-safe).
    const allSubjectsSafe = incomingSubjects.every((s) => isSafeIri(s));

    let sparql: string;
    if (allSubjectsSafe) {
      const subjectVals = incomingSubjects
        .map((s) => `<${assertSafeIri(s)}>`)
        .join(' ');
      sparql = `
        SELECT ?s ?p ?o WHERE {
          GRAPH ${escapedGraph} {
            VALUES ?s { ${subjectVals} }
            VALUES ?p { ${escapedPredicateVals} }
            ?s ?p ?o .
          }
        }
      `;
    } else {
      // At least one blank-node (or otherwise non-IRI) subject.
      // Drop the subject pin and rely on predicate narrowing +
      // post-filter against `subjects` set membership.
      sparql = `
        SELECT ?s ?p ?o WHERE {
          GRAPH ${escapedGraph} {
            VALUES ?p { ${escapedPredicateVals} }
            ?s ?p ?o .
          }
        }
      `;
    }
    const keys = new Set<string>();
    try {
      const result = await this.store.query(sparql);
      if (result.type !== 'bindings') return keys;
      for (const row of result.bindings) {
        const subjectStr = row['s'];
        if (subjectStr === undefined) continue;
        // Post-filter for the blank-node fallback path: only
        // dedup against subjects we are about to write. (For the
        // strict-IRI path the SPARQL VALUES already enforces this.)
        if (!allSubjectsSafe && !subjects.has(subjectStr)) continue;
        const plain = this.decryptLiteral(row['o']);
        keys.add(`${subjectStr}\u0001${row['p']}\u0001${plain}`);
      }
    } catch {
      // If the scoped read fails we fall back to no-dedup: worst case
      // is the historical behaviour (duplicate ciphertexts) — never a
      // confidentiality regression.
    }
    return keys;
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

    // Defence-in-depth (ST-7): reject unsafe IRIs at the entry point. The
    // other private-store operations (`getPrivateTriples`,
    // `hasPrivateTriplesInStore`, `deletePrivateTriples`) all route
    // `rootEntity` through `assertSafeIri` as they build SPARQL, so a
    // string like `did:dkg:agent:evil> <http://attacker/` that slipped in
    // here would land fine in the in-memory tracker and blow up only on
    // the first downstream query. Asserting at write time gives callers
    // an immediate, consistent error shape and keeps the tracker clean.
    assertSafeIri(rootEntity);

    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    // ST-2: encrypt the literal `object` BEFORE handing the quad to
    // the underlying TripleStore. URIs and blank nodes carry no
    // payload and are passed through unchanged. The resulting
    // on-disk N-Quads dump contains only ciphertext envelopes
    // (`enc:gcm:v1:<base64>`); callers retrieve plaintext via
    // `getPrivateTriples`, which reverses the seal.
    //
    // Because `encryptLiteral` uses a fresh random IV per call
    // (deterministic IVs are forbidden for AES-GCM), a plain
    // `insert()` would duplicate the quad on every retry / replay
    // of the same private KA: the store dedups by byte-identical
    // terms, but ciphertext is never byte-identical across writes.
    // Dedup here by decrypting the set of existing ciphertext
    // objects at each `(s, p)` position in this private graph and
    // skipping any incoming plaintext that is already there. The
    // comparison is on **plaintext** triple identity, which is the
    // semantic we want; it preserves random-IV confidentiality
    // while making the write idempotent.
    //
    // Hold a per-graph mutex for the whole "scan existing plaintext
    // + insert
    // missing quads" sequence so a second concurrent caller cannot
    // observe an empty key set in parallel and wind up inserting a
    // byte-distinct (random-IV) ciphertext for the same `(s,p,o)`
    // plaintext.
    await this.withGraphWriteLock(graphUri, async () => {
      const existingPlainKeys = await this.collectExistingPlaintextKeys(graphUri, quads);
      const toInsert: Quad[] = [];
      const seenInBatch = new Set<string>();
      for (const q of quads) {
        const key = `${q.subject}\u0001${q.predicate}\u0001${q.object}`;
        if (existingPlainKeys.has(key)) continue;
        if (seenInBatch.has(key)) continue;
        seenInBatch.add(key);
        toInsert.push({
          ...q,
          object: this.encryptLiteral(q.object),
          graph: graphUri,
        });
      }
      if (toInsert.length > 0) {
        await this.store.insert(toInsert);
      }
    });

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
      // the original literal value (. Non-encrypted
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
