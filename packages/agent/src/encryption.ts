import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha512 } from '@noble/hashes/sha2.js';

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
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
 */
export function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const n = nonce ?? randomBytes(24);
  const cipher = xchacha20poly1305(key, n);
  const ciphertext = cipher.encrypt(plaintext);
  return { ciphertext, nonce: n };
}

/**
 * Decrypts a ciphertext using XChaCha20-Poly1305.
 */
export function decrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
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
