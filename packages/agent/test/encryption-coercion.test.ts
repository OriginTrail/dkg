import { Buffer } from 'node:buffer';
import { describe, it, expect } from 'vitest';
import { asUint8Array, encrypt, decrypt } from '../src/encryption.js';

const KEY_LEN = 32;
const NONCE_LEN = 24;

function makeKey(byte: number): Uint8Array {
  return new Uint8Array(KEY_LEN).fill(byte);
}

function makeNonce(byte: number): Uint8Array {
  return new Uint8Array(NONCE_LEN).fill(byte);
}

// PR #568 (May 2026 multi-node soak follow-up). The soak surfaced 6
// hard fails of `"nonce" expected Uint8Array of length 24, got
// type=object` across 6570 sends. Codex review on the original
// classifier-only PR shape correctly noted that the assertion fires
// inside `@noble/ciphers` (XChaCha20-Poly1305 wiring at
// `messaging.ts:sendChat`), upstream of every send-side classifier
// — so the right fix is to coerce all crypto inputs to a strict
// `Uint8Array` at the encrypt/decrypt site. The tests below lock
// that coercion in.
describe('encryption.asUint8Array (PR #568 hydration-race coercion)', () => {
  it('passes a strict Uint8Array through without copying', () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    const out = asUint8Array(u8);
    expect(out).toBe(u8);
  });

  it('coerces a Node.js Buffer into a strict Uint8Array (no copy of backing memory)', () => {
    const buf = Buffer.from([10, 20, 30, 40]);
    const out = asUint8Array(buf);

    expect(out).not.toBe(buf as unknown as Uint8Array);
    expect(out.constructor).toBe(Uint8Array);
    expect(out instanceof Uint8Array).toBe(true);
    // Same backing buffer slice → zero-copy view.
    expect(out.buffer).toBe(buf.buffer);
    expect(out.byteOffset).toBe(buf.byteOffset);
    expect(out.byteLength).toBe(buf.byteLength);
    expect(Array.from(out)).toEqual([10, 20, 30, 40]);
  });

  it('coerces a JSON-revived Buffer `{type:"Buffer", data:[...]}` into a strict Uint8Array', () => {
    const revived = { type: 'Buffer', data: [5, 6, 7, 8] };
    const out = asUint8Array(revived);
    expect(out.constructor).toBe(Uint8Array);
    expect(Array.from(out)).toEqual([5, 6, 7, 8]);
  });

  it('coerces a plain number[] into a strict Uint8Array', () => {
    const arr = [99, 1, 0, 255];
    const out = asUint8Array(arr);
    expect(out.constructor).toBe(Uint8Array);
    expect(Array.from(out)).toEqual([99, 1, 0, 255]);
  });

  it('coerces a DataView into a strict Uint8Array sharing the backing buffer', () => {
    const ab = new ArrayBuffer(8);
    new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = new DataView(ab, 2, 4);
    const out = asUint8Array(view);
    expect(out.constructor).toBe(Uint8Array);
    expect(Array.from(out)).toEqual([3, 4, 5, 6]);
  });

  it('throws TypeError on a genuinely unsupported value (string/number/null/undefined)', () => {
    expect(() => asUint8Array('hello' as unknown)).toThrow(TypeError);
    expect(() => asUint8Array(42 as unknown)).toThrow(TypeError);
    expect(() => asUint8Array(null as unknown)).toThrow(TypeError);
    expect(() => asUint8Array(undefined as unknown)).toThrow(TypeError);
    // The TypeError mentions the actual offending type so the surfaced
    // error stays diagnosable (instead of being eaten by noble).
    expect(() => asUint8Array('x' as unknown)).toThrow(/got string/i);
    expect(() => asUint8Array(null as unknown)).toThrow(/got null/i);
  });

  // Codex review (PR #568 R5) caught that an overly-permissive
  // helper would silently reinterpret/wrap upstream wiring bugs
  // into incorrect bytes. These regressions lock the rejections
  // down so a bad shape produces a clear diagnostic instead of a
  // confusing crypto mismatch downstream.
  it('rejects non-byte-oriented typed arrays (Uint16Array, Int32Array, Float64Array)', () => {
    // Different bytes-per-element semantics — wrapping the
    // backing buffer would silently produce a different byte
    // sequence. Must surface as a TypeError instead.
    expect(() => asUint8Array(new Uint16Array([1, 2, 3]) as unknown)).toThrow(TypeError);
    expect(() => asUint8Array(new Int32Array([1, 2, 3]) as unknown)).toThrow(TypeError);
    expect(() => asUint8Array(new Float64Array([1.5, 2.5]) as unknown)).toThrow(TypeError);
  });

  it('rejects arrays with non-integer / out-of-range / non-number elements', () => {
    // `new Uint8Array([300])` would silently wrap to 44 (mod 256).
    expect(() => asUint8Array([300] as unknown)).toThrow(/integer in \[0, 255\]/i);
    expect(() => asUint8Array([-1] as unknown)).toThrow(/integer in \[0, 255\]/i);
    // `new Uint8Array(['x'])` would silently coerce NaN → 0.
    expect(() => asUint8Array(['x'] as unknown)).toThrow(/got string/i);
    // Non-integer numbers (`new Uint8Array([1.5])` truncates to 1).
    expect(() => asUint8Array([1.5] as unknown)).toThrow(/integer in \[0, 255\]/i);
    // The error points at the offending index, so debuggers can
    // locate the bad element fast.
    expect(() => asUint8Array([0, 1, 2, 300, 4] as unknown)).toThrow(/value\[3\]/i);
  });

  it('rejects JSON-revived Buffer whose `data` is not a valid byte array', () => {
    const badData = { type: 'Buffer', data: [0, 1, 256] };
    expect(() => asUint8Array(badData)).toThrow(/data\[2\]/i);
    const negData = { type: 'Buffer', data: [-1] };
    expect(() => asUint8Array(negData)).toThrow(/integer in \[0, 255\]/i);
  });

  // Codex PR #568 R6: the JSON-revived-Buffer branch must require
  // the literal `type: 'Buffer'` marker. Otherwise any object with
  // a `data: [...]` property (e.g. an unrelated payload envelope)
  // would be silently coerced into crypto bytes — exactly the
  // failure mode this PR is trying to surface.
  it('rejects objects with a `data` array but no `type: "Buffer"` marker', () => {
    expect(() => asUint8Array({ data: [1, 2, 3] } as unknown)).toThrow(TypeError);
    expect(() => asUint8Array({ type: 'Other', data: [1, 2, 3] } as unknown)).toThrow(TypeError);
    expect(() => asUint8Array({ type: 'buffer', data: [1, 2, 3] } as unknown)).toThrow(TypeError);
    // Even with the right marker, a non-array `data` must still
    // be rejected (don't try to be clever).
    expect(() => asUint8Array({ type: 'Buffer', data: 'AAEC' } as unknown)).toThrow(TypeError);
  });
});

describe('encryption.encrypt/decrypt with non-Uint8Array inputs (PR #568)', () => {
  const plaintext = new TextEncoder().encode('hello world');

  it('encrypts when nonce is a Node.js Buffer (the documented soak symptom)', () => {
    const key = makeKey(0xa1);
    // A `Buffer` is a subclass of Uint8Array but `constructor === Buffer`,
    // not `=== Uint8Array`. Pre-fix `@noble/ciphers` rejected this with
    // `"nonce" expected Uint8Array of length 24, got type=object`.
    const nonceBuf = Buffer.from(new Uint8Array(NONCE_LEN).fill(0x11));
    const { ciphertext, nonce } = encrypt(key, plaintext, nonceBuf as unknown as Uint8Array);
    expect(nonce.constructor).toBe(Uint8Array);
    expect(ciphertext.constructor).toBe(Uint8Array);
    // Roundtrip back to the original plaintext.
    const out = decrypt(key, ciphertext, nonce);
    expect(new TextDecoder().decode(out)).toBe('hello world');
  });

  it('encrypts when nonce is a JSON-revived Buffer ({type:"Buffer", data:[...]})', () => {
    const key = makeKey(0xa2);
    const nonce = { type: 'Buffer', data: Array(NONCE_LEN).fill(0x22) };
    const { ciphertext, nonce: outNonce } = encrypt(
      key,
      plaintext,
      nonce as unknown as Uint8Array,
    );
    expect(outNonce.constructor).toBe(Uint8Array);
    const roundtripped = decrypt(key, ciphertext, outNonce);
    expect(new TextDecoder().decode(roundtripped)).toBe('hello world');
  });

  it('encrypts when key is a Node.js Buffer', () => {
    const keyBuf = Buffer.from(new Uint8Array(KEY_LEN).fill(0xa3));
    const nonce = makeNonce(0x33);
    const { ciphertext, nonce: outNonce } = encrypt(
      keyBuf as unknown as Uint8Array,
      plaintext,
      nonce,
    );
    expect(outNonce).toBe(nonce);
    const roundtripped = decrypt(keyBuf as unknown as Uint8Array, ciphertext, outNonce);
    expect(new TextDecoder().decode(roundtripped)).toBe('hello world');
  });

  it('encrypts when plaintext is a Node.js Buffer', () => {
    const key = makeKey(0xa4);
    const nonce = makeNonce(0x44);
    const plaintextBuf = Buffer.from('hello world');
    const { ciphertext, nonce: outNonce } = encrypt(
      key,
      plaintextBuf as unknown as Uint8Array,
      nonce,
    );
    const roundtripped = decrypt(key, ciphertext, outNonce);
    expect(new TextDecoder().decode(roundtripped)).toBe('hello world');
  });

  it('decrypts when ciphertext is a Node.js Buffer (DB-read shape)', () => {
    const key = makeKey(0xa5);
    const nonce = makeNonce(0x55);
    const { ciphertext } = encrypt(key, plaintext, nonce);
    const ciphertextBuf = Buffer.from(ciphertext);
    const out = decrypt(key, ciphertextBuf as unknown as Uint8Array, nonce);
    expect(new TextDecoder().decode(out)).toBe('hello world');
  });

  it('preserves the strict-Uint8Array fast path (true Uint8Array nonce, no allocation)', () => {
    const key = makeKey(0xa6);
    const nonce = makeNonce(0x66);
    const { nonce: out } = encrypt(key, plaintext, nonce);
    // No coercion required → returned nonce is the same instance.
    expect(out).toBe(nonce);
  });

  it('still rejects a genuinely wrong-shape nonce (the value error must NOT be eaten)', () => {
    const key = makeKey(0xa7);
    // A string can't be coerced — asUint8Array throws a clear TypeError
    // instead of letting noble's cryptic assertion through.
    expect(() => encrypt(key, plaintext, 'not-bytes' as unknown as Uint8Array)).toThrow(
      /Expected byte-oriented value/i,
    );
  });
});
