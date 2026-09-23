import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { randomBytes } from 'node:crypto';
import {
  PROFILE_NODE_ID_MAX_BYTES,
  decodeProfileNodeId,
  encodeProfileNodeId,
  encodeProfileNodeIdHex,
} from '../src/index.js';

// A Base mainnet relay's peer id (network/mainnet-base.json) and its V6/V8
// on-chain form: hexlify(toUtf8Bytes(peerId)).
const RELAY_PEER_ID = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const RELAY_NODE_ID_HEX = `0x${Buffer.from(RELAY_PEER_ID, 'utf8').toString('hex')}`;
// The canonical RSA example from the libp2p peer-id spec (sha256 multihash).
const RSA_PEER_ID = 'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N';

async function peerIdOf(type: 'Ed25519' | 'secp256k1') {
  return peerIdFromPrivateKey(await generateKeyPair(type));
}

const hexOf = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

describe('encodeProfileNodeId', () => {
  it('writes the UTF-8 bytes of the base58btc peer id string (the V6/V8 encoding)', () => {
    expect(encodeProfileNodeIdHex(RELAY_PEER_ID)).toBe(RELAY_NODE_ID_HEX);
    expect(Buffer.from(encodeProfileNodeId(RELAY_PEER_ID)).toString('utf8')).toBe(RELAY_PEER_ID);
    expect(encodeProfileNodeId(RELAY_PEER_ID)).toHaveLength(52);
  });

  it('encodes Ed25519, secp256k1 and RSA peer ids, from strings or PeerId objects', async () => {
    const ed25519 = await peerIdOf('Ed25519');
    const secp256k1 = await peerIdOf('secp256k1');
    expect(encodeProfileNodeId(ed25519)).toEqual(new TextEncoder().encode(ed25519.toString()));
    expect(encodeProfileNodeId(ed25519.toString())).toHaveLength(52);
    expect(encodeProfileNodeId(secp256k1)).toHaveLength(53);
    expect(encodeProfileNodeId(RSA_PEER_ID)).toHaveLength(46);
    for (const peer of [ed25519.toString(), secp256k1.toString(), RSA_PEER_ID]) {
      expect(encodeProfileNodeId(peer).length).toBeLessThanOrEqual(PROFILE_NODE_ID_MAX_BYTES);
    }
  });

  it('rejects anything that is not a canonical key-backed peer id string', async () => {
    const ed25519 = await peerIdOf('Ed25519');
    const rejected = [
      '',
      ` ${RELAY_PEER_ID}`,
      `${RELAY_PEER_ID}\n`,
      ed25519.toCID().toString(), // CIDv1 (bafz…) form of a valid peer id
      `z${RELAY_PEER_ID}`, // multibase-prefixed
      RELAY_PEER_ID.slice(0, -1), // truncated
      '11111111111111111111111111111111',
      'not a peer id',
      '0x' + 'ab'.repeat(32),
    ];
    for (const value of rejected) {
      expect(() => encodeProfileNodeId(value), JSON.stringify(value)).toThrow(/not a canonical libp2p peer id/);
    }
  });
});

describe('decodeProfileNodeId', () => {
  it('round-trips every key type, from bytes or 0x hex', async () => {
    for (const peer of [
      (await peerIdOf('Ed25519')).toString(),
      (await peerIdOf('secp256k1')).toString(),
      RSA_PEER_ID,
      RELAY_PEER_ID,
    ]) {
      const bytes = encodeProfileNodeId(peer);
      expect(decodeProfileNodeId(bytes)).toBe(peer);
      expect(decodeProfileNodeId(hexOf(bytes))).toBe(peer);
      expect(decodeProfileNodeId(hexOf(bytes).toUpperCase().replace('0X', '0x'))).toBe(peer);
      // The decoded string parses back to the same libp2p peer.
      expect(peerIdFromString(decodeProfileNodeId(bytes)!).toString()).toBe(peer);
    }
  });

  it('returns null for legacy random nodeIds', () => {
    for (let i = 0; i < 500; i++) {
      expect(decodeProfileNodeId(randomBytes(32))).toBeNull();
    }
  });

  it('returns null for the non-canonical encodings of a valid peer id', async () => {
    const peer = await peerIdOf('Ed25519');
    const utf8 = (text: string) => new TextEncoder().encode(text);
    expect(decodeProfileNodeId(peer.toMultihash().bytes)).toBeNull(); // raw multihash bytes
    expect(decodeProfileNodeId(peer.toCID().bytes)).toBeNull(); // raw CID bytes
    expect(decodeProfileNodeId(utf8(peer.toCID().toString()))).toBeNull(); // CID string
    expect(decodeProfileNodeId(utf8(` ${peer.toString()}`))).toBeNull();
    expect(decodeProfileNodeId(utf8(`${peer.toString()} `))).toBeNull();
    expect(decodeProfileNodeId(utf8(`z${peer.toString()}`))).toBeNull();
    // Exactly one byte string per peer id: every encoding above is distinct
    // from the canonical one, and only the canonical one decodes.
    expect(decodeProfileNodeId(encodeProfileNodeId(peer))).toBe(peer.toString());
  });

  it('returns null for empty, malformed, oversize and non-UTF-8 input', () => {
    expect(decodeProfileNodeId(new Uint8Array())).toBeNull();
    expect(decodeProfileNodeId('0x')).toBeNull();
    expect(decodeProfileNodeId('0x123')).toBeNull(); // odd length
    expect(decodeProfileNodeId('0xzz')).toBeNull();
    expect(decodeProfileNodeId(RELAY_PEER_ID)).toBeNull(); // a string input must be 0x hex
    expect(decodeProfileNodeId(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
    expect(decodeProfileNodeId(new TextEncoder().encode('1'.repeat(PROFILE_NODE_ID_MAX_BYTES + 1)))).toBeNull();
    expect(decodeProfileNodeId(new TextEncoder().encode('11111111111111111111111111111111'))).toBeNull();
  });
});
