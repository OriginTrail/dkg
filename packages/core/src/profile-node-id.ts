/**
 * On-chain Profile `nodeId` <-> libp2p peer id.
 *
 * Canonical encoding (what a node writes through `Profile.createProfile` and
 * `Profile.updateNodeId`): the UTF-8 bytes of the peer id's base58btc string.
 * That is `12D3KooW…` for Ed25519 (52 bytes), `16Uiu2…` for secp256k1
 * (53 bytes) and `Qm…` for RSA/ECDSA keys hashed into a sha256 multihash
 * (46 bytes). V6 and V8 ot-node wrote exactly this (`toUtf8Bytes(peerId)`),
 * and `ShardingTable` places a node at sha256 of these bytes, which is sha256
 * of the peer id string, as V6/V8 computed it off-chain.
 *
 * Decoding accepts ONLY that canonical form. The bytes must be valid UTF-8,
 * parse as a key-backed libp2p peer id (Ed25519, secp256k1 or RSA), and
 * re-encode to the identical string. Raw multihash bytes, CID strings, padded
 * text and the legacy random 32-byte nodeIds all decode to `null`. Each peer
 * id therefore has exactly one on-chain byte string, so ProfileStorage's
 * byte-level uniqueness (`nodeIdsList`) is peer-id uniqueness: a second
 * identity cannot claim the same peer under an alternate encoding.
 *
 * A decoded peer id is a CLAIM made by the identity's keys, not a proof: the
 * contract cannot verify that the identity controls the libp2p key. Dialing
 * the peer authenticates the peer id (Noise), so a consumer must still treat
 * data from it as untrusted and verify it against on-chain roots.
 */
import { peerIdFromString } from '@libp2p/peer-id';

/** Mirrors `Profile.MAX_NODE_ID_LENGTH` (Profile >= 10.1.0). */
export const PROFILE_NODE_ID_MAX_BYTES = 64;

const BASE58BTC_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const KEY_BACKED_PEER_ID_TYPES: ReadonlySet<string> = new Set(['Ed25519', 'secp256k1', 'RSA']);

/** The input when it is already the canonical base58btc string of a key-backed peer id. */
function canonicalKeyBackedPeerId(text: string): string | null {
  if (text.length === 0 || text.length > PROFILE_NODE_ID_MAX_BYTES) return null;
  if (!BASE58BTC_TEXT.test(text)) return null;
  let parsed: ReturnType<typeof peerIdFromString>;
  try {
    parsed = peerIdFromString(text);
  } catch {
    return null;
  }
  if (!KEY_BACKED_PEER_ID_TYPES.has(parsed.type)) return null;
  const canonical = parsed.toString();
  return canonical === text ? canonical : null;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!HEX_BYTES.test(hex)) return null;
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function describeInput(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

/**
 * The canonical on-chain nodeId bytes for `peerId`.
 *
 * Throws unless `peerId` is the canonical base58btc string of an Ed25519,
 * secp256k1 or RSA peer id (a libp2p `PeerId` object's `toString()` is).
 */
export function encodeProfileNodeId(peerId: string | { toString(): string }): Uint8Array {
  const text = typeof peerId === 'string' ? peerId : peerId.toString();
  const canonical = canonicalKeyBackedPeerId(text);
  if (canonical === null) {
    throw new Error(`encodeProfileNodeId: not a canonical libp2p peer id: ${describeInput(text)}`);
  }
  return new TextEncoder().encode(canonical);
}

/** {@link encodeProfileNodeId} as a `0x`-prefixed lowercase hex string (the form ethers returns for `bytes`). */
export function encodeProfileNodeIdHex(peerId: string | { toString(): string }): string {
  return bytesToHex(encodeProfileNodeId(peerId));
}

/**
 * The peer id an on-chain Profile nodeId names, or `null` when the nodeId is
 * not the canonical encoding of a key-backed libp2p peer id (for example a
 * legacy random nodeId, an empty value or malformed hex).
 *
 * Accepts the raw bytes or the `0x` hex string ethers returns for `bytes`.
 */
export function decodeProfileNodeId(nodeId: Uint8Array | string): string | null {
  const bytes = typeof nodeId === 'string' ? hexToBytes(nodeId) : nodeId;
  if (bytes === null || bytes.length === 0 || bytes.length > PROFILE_NODE_ID_MAX_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return canonicalKeyBackedPeerId(text);
}
