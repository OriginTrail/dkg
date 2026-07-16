import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  dkgGossipMsgId,
  dkgGossipMsgIdRaw,
  DkgGossipUnsignedMessageError,
} from '../src/network/gossip-msg-id.js';

/**
 * RFC 07 §5.4 — `dkgGossipMsgId` is the content-deterministic msgId
 * locked in for cross-backend gossip dedup. These tests pin the exact
 * encoding so any change is caught at code-review time.
 *
 * Codex review feedback on PR #501 made two semantic changes:
 *   1. length-framing each field to avoid ("ab","c")=("a","bc") collisions
 *   2. including sequenceNumber for signed messages so retries get
 *      distinct msgIds (otherwise the same peer republishing the same
 *      payload would be dropped as a dup by gossipsub itself).
 * Both are pinned by tests below.
 */
describe('dkgGossipMsgId (RFC 07 §5.4)', () => {
  const TOPIC = 'dkg/cg/topic-a/1.0.0';
  const PAYLOAD = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  // Minimal PeerId stand-in: the function only reads `.toMultihash().bytes`.
  const FROM_BYTES = new Uint8Array([0xAA, 0xBB, 0xCC]);
  const fakePeerId = {
    toMultihash: () => ({ bytes: FROM_BYTES }),
  } as unknown as Parameters<typeof dkgGossipMsgId>[0] extends infer M
    ? M extends { from: infer P }
      ? P
      : never
    : never;

  function u32be(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
  }
  function u64be(n: bigint): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, false);
    return b;
  }
  function expected(topic: string, data: Uint8Array, from: Uint8Array, seqno: bigint): Uint8Array {
    const topicBytes = new TextEncoder().encode(topic);
    const total = 4 + topicBytes.length + 4 + data.length + 4 + from.length + 8;
    const buf = new Uint8Array(total);
    let off = 0;
    buf.set(u32be(topicBytes.length), off); off += 4;
    buf.set(topicBytes, off);                off += topicBytes.length;
    buf.set(u32be(data.length), off);        off += 4;
    buf.set(data, off);                      off += data.length;
    buf.set(u32be(from.length), off);        off += 4;
    buf.set(from, off);                      off += from.length;
    buf.set(u64be(seqno), off);
    return sha256(buf);
  }

  it('signed: length-framed sha256 with seqno', () => {
    const id = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 42n, signature: new Uint8Array(), key: {} as never,
    });
    expect(id).toEqual(expected(TOPIC, PAYLOAD, FROM_BYTES, 42n));
    expect(id.length).toBe(32);
  });

  // Codex review feedback on PR #501 round 4: unsigned messages have
  // no publisher identity and no seqno, which would let two different
  // publishers' identical payloads collapse to the same msgId. The
  // function rejects them so the false-dedup case is impossible.
  it('unsigned: throws DkgGossipUnsignedMessageError', () => {
    expect(() =>
      dkgGossipMsgId({ type: 'unsigned', topic: TOPIC, data: PAYLOAD }),
    ).toThrow(DkgGossipUnsignedMessageError);
  });

  it('different topics → different msgIds (same payload + from + seqno)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: 'topic-a', data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: 'topic-b', data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('different payloads → different msgIds (same topic + from + seqno)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: new Uint8Array([1]), from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: new Uint8Array([2]), from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('different from-identities → different msgIds', () => {
    const altFrom = {
      toMultihash: () => ({ bytes: new Uint8Array([0x11, 0x22, 0x33]) }),
    } as unknown as Parameters<typeof dkgGossipMsgId>[0] extends infer M
      ? M extends { from: infer P } ? P : never : never;
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: altFrom,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('UTF-8 topics work', () => {
    const utf8Topic = 'cg/тема/1.0.0';
    const id = dkgGossipMsgId({
      type: 'signed', topic: utf8Topic, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 7n, signature: new Uint8Array(), key: {} as never,
    });
    expect(id).toEqual(expected(utf8Topic, PAYLOAD, FROM_BYTES, 7n));
  });

  // Codex review feedback on PR #501 — these are the regressions the
  // earlier draft would have shipped. Pin them.

  it('Codex bug #1: length-framing prevents ("ab","c") = ("a","bc") collision', () => {
    const id1 = dkgGossipMsgId({
      type: 'signed', topic: 'ab', data: new TextEncoder().encode('c'), from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    const id2 = dkgGossipMsgId({
      type: 'signed', topic: 'a', data: new TextEncoder().encode('bc'), from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    expect(id1).not.toEqual(id2);
  });

  it('Codex bug #2: same peer republishing same payload gets distinct msgIds via seqno', () => {
    const first = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const retry = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 2n, signature: new Uint8Array(), key: {} as never,
    });
    expect(first).not.toEqual(retry);
  });

  it('seqno of the same value reproduces the same msgId (deterministic)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 99n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 99n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).toEqual(b);
  });

  it('signature and key do NOT enter the msgId (content+seqno-deterministic)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array([0x01]), key: { kind: 'a' } as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array([0xFF, 0xFF]), key: { kind: 'b' } as never,
    });
    expect(a).toEqual(b);
  });

  // Codex review feedback on PR #501 round 5: the encoding can drift if
  // both production and test are mutated together via `expected()`. This
  // pins the exact 32-byte SHA256 output for a known input so any
  // change to the framing/hash bytes is caught even if the helper is
  // wrong in the same way the prod code is.
  //
  // Vector:
  //   topic = 'dkg/test/1.0.0'
  //   data  = [0x01, 0x02, 0x03, 0x04]
  //   from  = [0x12, 0x34, 0x56]
  //   seq   = 7n
  // Pre-hash:
  //   0000000e 646b672f746573742f312e302e30 00000004 01020304
  //                                                      00000003 123456 0000000000000007
  // SHA256:
  //   17dc679d5ac2b669fc946ead91f08728a2dc33f8799f3b3bf3df04384959caa8
  it('FIXED VECTOR: pinned 32-byte SHA256 for a known input (libp2p adapter)', () => {
    const knownFrom = {
      toMultihash: () => ({ bytes: new Uint8Array([0x12, 0x34, 0x56]) }),
    } as unknown as Parameters<typeof dkgGossipMsgId>[0] extends infer M
      ? M extends { from: infer P } ? P : never : never;
    const id = dkgGossipMsgId({
      type: 'signed',
      topic: 'dkg/test/1.0.0',
      data: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      from: knownFrom,
      sequenceNumber: 7n,
      signature: new Uint8Array(),
      key: {} as never,
    });
    const hex = Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(
      '17dc679d5ac2b669fc946ead91f08728a2dc33f8799f3b3bf3df04384959caa8',
    );
  });
});

// Codex review feedback on PR #501 round 5: the libp2p-shaped function
// alone makes the "cross-backend dedup" framing aspirational. Pinning
// the backend-agnostic primitive separately, plus asserting the libp2p
// adapter delegates to it, locks in the contract: any future backend
// adapter (iroh-gossip, etc.) just needs to feed canonical bytes into
// `dkgGossipMsgIdRaw` and gets the same dedup behaviour.
describe('dkgGossipMsgIdRaw (RFC 07 §5.4 — backend-agnostic primitive)', () => {
  it('FIXED VECTOR: pinned 32-byte SHA256 (matches libp2p adapter vector)', () => {
    const id = dkgGossipMsgIdRaw({
      topic: 'dkg/test/1.0.0',
      data: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      publisherIdBytes: new Uint8Array([0x12, 0x34, 0x56]),
      sequenceNumber: 7n,
    });
    const hex = Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(
      '17dc679d5ac2b669fc946ead91f08728a2dc33f8799f3b3bf3df04384959caa8',
    );
  });

  it('libp2p adapter agrees with raw primitive on every signed message', () => {
    const fromBytes = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const peerId = {
      toMultihash: () => ({ bytes: fromBytes }),
    } as unknown as Parameters<typeof dkgGossipMsgId>[0] extends infer M
      ? M extends { from: infer P } ? P : never : never;
    const adapterId = dkgGossipMsgId({
      type: 'signed',
      topic: 'cg/topic-x/1.0.0',
      data: new Uint8Array([9, 9, 9]),
      from: peerId,
      sequenceNumber: 1234n,
      signature: new Uint8Array(),
      key: {} as never,
    });
    const rawId = dkgGossipMsgIdRaw({
      topic: 'cg/topic-x/1.0.0',
      data: new Uint8Array([9, 9, 9]),
      publisherIdBytes: fromBytes,
      sequenceNumber: 1234n,
    });
    expect(adapterId).toEqual(rawId);
  });

  it('length-framing collision check applies at the raw level too', () => {
    const a = dkgGossipMsgIdRaw({
      topic: 'ab', data: new TextEncoder().encode('c'),
      publisherIdBytes: new Uint8Array([1]), sequenceNumber: 0n,
    });
    const b = dkgGossipMsgIdRaw({
      topic: 'a', data: new TextEncoder().encode('bc'),
      publisherIdBytes: new Uint8Array([1]), sequenceNumber: 0n,
    });
    expect(a).not.toEqual(b);
  });

  it('seqno enters the hash at the raw level too', () => {
    const a = dkgGossipMsgIdRaw({
      topic: 't', data: new Uint8Array([1]),
      publisherIdBytes: new Uint8Array([2]), sequenceNumber: 1n,
    });
    const b = dkgGossipMsgIdRaw({
      topic: 't', data: new Uint8Array([1]),
      publisherIdBytes: new Uint8Array([2]), sequenceNumber: 2n,
    });
    expect(a).not.toEqual(b);
  });

  it('returns a 32-byte SHA256 digest', () => {
    const id = dkgGossipMsgIdRaw({
      topic: 't', data: new Uint8Array(),
      publisherIdBytes: new Uint8Array([1]), sequenceNumber: 0n,
    });
    expect(id.length).toBe(32);
  });

  // Codex review feedback PR #501 round 6 (branarakic, gossip-msg-id.ts:142):
  // the libp2p adapter rejects unsigned messages because they have no
  // publisher identity, but the raw primitive used to silently accept
  // an empty publisherIdBytes — reopening the false-dedup hazard the
  // adapter fixed. Reject empty publishers at the raw API boundary too.
  it('Codex PR #501 round 6: throws when publisherIdBytes is empty', () => {
    expect(() => dkgGossipMsgIdRaw({
      topic: 't', data: new Uint8Array([1, 2, 3]),
      publisherIdBytes: new Uint8Array(),
      sequenceNumber: 0n,
    })).toThrow(/publisherIdBytes must be non-empty/);
  });
});
