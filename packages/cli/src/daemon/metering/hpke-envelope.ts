// P3 Phase A — HPKE (RFC 9180) envelope, mode_base, single-shot.
//
// Suite: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM — chosen
// EXACTLY because it is the RFC's test-vector suite A.1, so the gate suite
// verifies this implementation against the official published vectors rather
// than against itself. The buyer seals the prompt to the enclave-held public
// key; plaintext exists only inside the (Phase A: SIMULATED) enclave boundary;
// the response is sealed back to the buyer's ephemeral key.
//
// SCOPE (stated plainly, per the honest-prototype rule): this file is
// cryptography only. Nothing here is, claims to be, or is presented as
// confidential compute — the hardware root of trust arrives in Phase B.
import {
  createHmac, createCipheriv, createDecipheriv, createPublicKey, createPrivateKey,
  generateKeyPairSync, diffieHellman, randomBytes, timingSafeEqual, type KeyObject,
} from "node:crypto";

// ── suite constants (RFC 9180 §7) ──
const KEM_ID = 0x0020;   // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001;   // HKDF-SHA256
const AEAD_ID = 0x0001;  // AES-128-GCM
const NK = 16, NN = 12, NH = 32;
const MODE_BASE = 0x00;

const i2osp2 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const SUITE_ID = Buffer.concat([Buffer.from("HPKE"), i2osp2(KEM_ID), i2osp2(KDF_ID), i2osp2(AEAD_ID)]);
const KEM_SUITE_ID = Buffer.concat([Buffer.from("KEM"), i2osp2(KEM_ID)]);

// ── HKDF-SHA256 primitives (explicit, for labeled variants) ──
const hkdfExtract = (salt: Buffer, ikm: Buffer) =>
  createHmac("sha256", salt.length ? salt : Buffer.alloc(NH)).update(ikm).digest();
function hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer {
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; out.reduce((a, b) => a + b.length, 0) < len; i++) {
    prev = createHmac("sha256", prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, len);
}
const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) =>
  hkdfExtract(salt, Buffer.concat([Buffer.from("HPKE-v1"), suite, Buffer.from(label), ikm]));
const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, len: number) =>
  hkdfExpand(prk, Buffer.concat([i2osp2(len), Buffer.from("HPKE-v1"), suite, Buffer.from(label), info]), len);

// ── X25519 raw-key plumbing (Node wants SPKI/PKCS8 wrappers) ──
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
export const x25519PublicFromRaw = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
export const x25519PrivateFromRaw = (raw: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
export const x25519RawPublic = (pub: KeyObject): Buffer =>
  (pub.export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_X25519.length);

export function generateHpkeKeyPair(): { publicKeyRaw: Buffer; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKeyRaw: x25519RawPublic(publicKey), privateKey };
}

// ── DHKEM encap/decap (RFC 9180 §4.1) ──
function extractAndExpand(dh: Buffer, kemContext: Buffer): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE_ID, Buffer.alloc(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, NH);
}
function encap(pkR: Buffer, ephemeral?: { privateKey: KeyObject; publicKeyRaw: Buffer }): { sharedSecret: Buffer; enc: Buffer } {
  const e = ephemeral ?? generateHpkeKeyPair();
  const dh = diffieHellman({ privateKey: e.privateKey, publicKey: x25519PublicFromRaw(pkR) });
  const enc = e.publicKeyRaw;
  return { sharedSecret: extractAndExpand(dh, Buffer.concat([enc, pkR])), enc };
}
function decap(enc: Buffer, skR: KeyObject, pkR: Buffer): Buffer {
  const dh = diffieHellman({ privateKey: skR, publicKey: x25519PublicFromRaw(enc) });
  return extractAndExpand(dh, Buffer.concat([enc, pkR]));
}

// ── key schedule, mode_base (RFC 9180 §5.1) ──
function keySchedule(sharedSecret: Buffer, info: Buffer): { key: Buffer; baseNonce: Buffer; exporterSecret: Buffer } {
  const pskIdHash = labeledExtract(SUITE_ID, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0));
  const infoHash = labeledExtract(SUITE_ID, Buffer.alloc(0), "info_hash", info);
  const ksc = Buffer.concat([Buffer.from([MODE_BASE]), pskIdHash, infoHash]);
  const secret = labeledExtract(SUITE_ID, sharedSecret, "secret", Buffer.alloc(0));
  return {
    key: labeledExpand(SUITE_ID, secret, "key", ksc, NK),
    baseNonce: labeledExpand(SUITE_ID, secret, "base_nonce", ksc, NN),
    exporterSecret: labeledExpand(SUITE_ID, secret, "exp", ksc, NH),
  };
}
const nonceAt = (baseNonce: Buffer, seq: number): Buffer => {
  const n = Buffer.from(baseNonce);
  // XOR the big-endian seq into the low-order bytes (seq is bounded far below 2^53)
  for (let i = 0; i < 8; i++) n[NN - 1 - i] ^= Number((BigInt(seq) >> BigInt(8 * i)) & 0xffn);
  return n;
};

// ── single-shot seal/open (seq 0) + multi-seq context for streamless legs ──
export interface SealedEnvelope { enc: string; ct: string }   // hex
export function seal(pkRecipientRaw: Buffer, info: Buffer, aad: Buffer, plaintext: Buffer,
  testEphemeral?: { privateKey: KeyObject; publicKeyRaw: Buffer }): SealedEnvelope {
  const { sharedSecret, enc } = encap(pkRecipientRaw, testEphemeral);
  const { key, baseNonce } = keySchedule(sharedSecret, info);
  const cipher = createCipheriv("aes-128-gcm", key, nonceAt(baseNonce, 0));
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { enc: enc.toString("hex"), ct: ct.toString("hex") };
}
export function open(envelope: SealedEnvelope, skRecipient: KeyObject, pkRecipientRaw: Buffer, info: Buffer, aad: Buffer):
  { ok: true; plaintext: Buffer } | { ok: false; code: "E_HPKE_OPEN_FAILED" } {
  try {
    const enc = Buffer.from(envelope.enc, "hex");
    const ctFull = Buffer.from(envelope.ct, "hex");
    if (enc.length !== 32 || ctFull.length < 16) return { ok: false, code: "E_HPKE_OPEN_FAILED" };
    const sharedSecret = decap(enc, skRecipient, pkRecipientRaw);
    const { key, baseNonce } = keySchedule(sharedSecret, info);
    const tag = ctFull.subarray(ctFull.length - 16);
    const ct = ctFull.subarray(0, ctFull.length - 16);
    const d = createDecipheriv("aes-128-gcm", key, nonceAt(baseNonce, 0));
    d.setAAD(aad); d.setAuthTag(tag);
    return { ok: true, plaintext: Buffer.concat([d.update(ct), d.final()]) };
  } catch { return { ok: false, code: "E_HPKE_OPEN_FAILED" }; }
}

/** hpkeKeyId — the receipt-v0.7 identifier of the key a prompt was sealed to:
 *  sha256 over the raw public key, prefixed for auditability. */
import { createHash } from "node:crypto";
export const hpkeKeyId = (publicKeyRaw: Buffer): string =>
  "hpke-x25519:" + createHash("sha256").update(publicKeyRaw).digest("hex");

/** Internal surfaces exposed for the RFC test-vector gate ONLY. */
export const _testInternals = { encap, decap, keySchedule, extractAndExpand, nonceAt };
export const timingSafeEqualHex = (a: string, b: string) => {
  const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
