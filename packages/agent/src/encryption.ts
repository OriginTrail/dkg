import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha512 } from '@noble/hashes/sha2.js';

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/**
 * Coerces a byte-like value into a strict `Uint8Array` instance.
 *
 * Defense-in-depth for the May 2026 multi-node soak symptom (6/6570
 * hard fails of `"nonce" expected Uint8Array of length 24, got
 * type=object`). `@noble/ciphers`'s XChaCha20-Poly1305 nonce check
 * rejects values whose constructor isn't strictly `Uint8Array` —
 * which means anything reaching us as one of:
 *
 *   - Node.js `Buffer` (subclass of Uint8Array, but
 *     `constructor === Buffer`)
 *   - structured-clone-restored or JSON-revived Buffer
 *     (`{ type: 'Buffer', data: number[] }`)
 *   - plain `number[]` (some IPC paths serialize this way)
 *
 * …will hard-fail synchronously at the encrypt/decrypt call,
 * upstream of the substrate's outbox classifier and therefore
 * unrecoverable at the network layer. Coercing here makes the
 * symptom structurally impossible regardless of how the value
 * was hydrated (DB read, worker-thread postMessage, IPC, etc.).
 *
 * ### Safety constraints (Codex PR #568 review)
 *
 * This helper deliberately rejects shapes that LOOK byte-like but
 * are not actually byte-oriented, so an upstream wiring bug
 * surfaces as a clear `TypeError` instead of being silently
 * reinterpreted into different bytes:
 *
 *   - `Uint16Array` / `Int32Array` / `Float64Array` / etc. have
 *     different bytes-per-element semantics; reinterpreting their
 *     backing buffer as `Uint8Array` would silently produce a
 *     different byte sequence. Rejected.
 *   - `number[]` / `{ type: 'Buffer', data: number[] }` are
 *     validated element-by-element: each entry must be an integer
 *     in `[0, 255]`. Otherwise `new Uint8Array([300])` would
 *     silently wrap to `44`, `new Uint8Array(['x'])` to `0`, etc.
 *
 * Accepted shapes:
 *
 *   - Strict `Uint8Array` → returned unchanged (no allocation)
 *   - `Uint8Array` subclass (`Buffer`) → zero-copy view via
 *     `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)`
 *   - `DataView` → zero-copy view (byte-oriented by construction)
 *   - Validated `number[]` → fresh `Uint8Array`
 *   - JSON-revived Buffer `{ type: 'Buffer', data: number[] }`
 *     with validated `data` → fresh `Uint8Array`
 */
export function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array && value.constructor === Uint8Array) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof DataView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isJsonRevivedBuffer(value)) {
    const data = (value as { data: unknown[] }).data;
    assertByteArray(data, 'data');
    return new Uint8Array(data as number[]);
  }
  if (Array.isArray(value)) {
    assertByteArray(value, 'value');
    return new Uint8Array(value as number[]);
  }
  throw new TypeError(
    `Expected byte-oriented value (Uint8Array | Buffer | DataView | { type: "Buffer", data: number[] } | number[]), got ${
      value === null ? 'null' : typeof value
    }`,
  );
}

/**
 * Tightened in Codex PR #568 review (R6): the previous check
 * accepted any object with a `data: [...]` property, which would
 * have silently reinterpreted unrelated payload objects as crypto
 * bytes. Now requires the literal `type: 'Buffer'` marker — the
 * exact shape `JSON.stringify(Buffer.from(...))` produces.
 */
function isJsonRevivedBuffer(value: unknown): value is { type: 'Buffer'; data: unknown[] } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as { type?: unknown; data?: unknown };
  return obj.type === 'Buffer' && Array.isArray(obj.data);
}

function assertByteArray(arr: unknown[], label: string): void {
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (
      typeof x !== 'number' ||
      !Number.isInteger(x) ||
      x < 0 ||
      x > 255
    ) {
      throw new TypeError(
        `Expected byte-oriented value: ${label}[${i}] must be an integer in [0, 255], got ${
          typeof x === 'number' ? String(x) : typeof x
        }`,
      );
    }
  }
}

/**
 * Derives an X25519 private key from an Ed25519 private key (seed).
 * Per RFC 8032, the Ed25519 scalar is the first 32 bytes of SHA-512(seed),
 * clamped. This scalar is a valid X25519 private key.
 */
export function ed25519ToX25519Private(ed25519Seed: Uint8Array): Uint8Array {
  const h = sha512(ed25519Seed.slice(0, 32));
  const scalar = h.slice(0, 32);
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

/**
 * Derives an X25519 public key from an Ed25519 public key.
 * Uses the birational map from Edwards to Montgomery form.
 */
export function ed25519ToX25519Public(ed25519Public: Uint8Array): Uint8Array {
  const p = 2n ** 255n - 19n;
  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(ed25519Public[i]) << BigInt(8 * i);
  }
  y &= (1n << 255n) - 1n;

  const u = mod((1n + y) * modInverse(1n - y, p), p);

  const result = new Uint8Array(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return result;
}

/**
 * X25519 Diffie-Hellman shared secret.
 */
export function x25519SharedSecret(
  ourPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(ourPrivateKey, theirPublicKey);
}

/**
 * Encrypts a plaintext using XChaCha20-Poly1305 with a 24-byte nonce.
 *
 * All byte inputs are defensively coerced to strict `Uint8Array`
 * via {@link asUint8Array} before reaching `@noble/ciphers`. See
 * the `asUint8Array` doc for why this matters (May 2026 soak
 * symptom + Codex PR #568 review).
 */
export function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const n = nonce !== undefined ? asUint8Array(nonce) : randomBytes(24);
  const k = asUint8Array(key);
  const p = asUint8Array(plaintext);
  const cipher = xchacha20poly1305(k, n);
  const ciphertext = cipher.encrypt(p);
  return { ciphertext, nonce: n };
}

/**
 * Decrypts a ciphertext using XChaCha20-Poly1305.
 *
 * All byte inputs are defensively coerced to strict `Uint8Array`
 * via {@link asUint8Array} before reaching `@noble/ciphers`. See
 * the `asUint8Array` doc for why this matters (May 2026 soak
 * symptom + Codex PR #568 review).
 */
export function decrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const cipher = xchacha20poly1305(asUint8Array(key), asUint8Array(nonce));
  return cipher.decrypt(asUint8Array(ciphertext));
}

function mod(a: bigint, m: bigint): bigint {
  return ((a % m) + m) % m;
}

function modInverse(a: bigint, m: bigint): bigint {
  return modPow(a, m - 2n, m);
}

function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  let result = 1n;
  base = mod(base, modulus);
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, modulus);
    exp >>= 1n;
    base = mod(base * base, modulus);
  }
  return result;
}
