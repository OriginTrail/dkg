/**
 * Finalization proto encode/decode edge cases (uint64 bounds, garbage input).
 */
import { describe, it, expect } from 'vitest';
import { encodeFinalizationMessage, decodeFinalizationMessage } from '../src/proto/finalization.js';

const MAX_UINT64 = (1n << 64n) - 1n;

function minimalFinalization(overrides: Record<string, unknown> = {}) {
  return {
    ual: 'did:dkg:evm:31337/0x0/1',
    contextGraphId: 'p',
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0xab',
    blockNumber: 1,
    batchId: 1,
    startKAId: 1,
    endKAId: 1,
    publisherAddress: '0x1111111111111111111111111111111111111111',
    rootEntities: [] as string[],
    timestampMs: 1,
    ...overrides,
  };
}

describe('encodeFinalizationMessage uint64 bounds', () => {
  it('accepts bigint at uint64 max', () => {
    const buf = encodeFinalizationMessage(
      minimalFinalization({
        blockNumber: MAX_UINT64,
        batchId: MAX_UINT64,
        startKAId: MAX_UINT64,
        endKAId: MAX_UINT64,
        timestampMs: MAX_UINT64,
      }) as any,
    );
    const dec = decodeFinalizationMessage(buf);
    expect(BigInt(dec.blockNumber as any)).toBe(MAX_UINT64);
  });

  it('throws RangeError when any uint64 field overflows', () => {
    // batchId is now the 256-bit-safe decimal-string KA-id wire (OT-RFC-43 §9),
    // so it can never uint64-overflow. blockNumber is still a genuine uint64
    // field guarded by bigIntToProtoSafe — keep the overflow coverage there.
    expect(() =>
      encodeFinalizationMessage(minimalFinalization({ blockNumber: MAX_UINT64 + 1n }) as any),
    ).toThrow(RangeError);
    expect(() =>
      encodeFinalizationMessage(minimalFinalization({ timestampMs: -1n }) as any),
    ).toThrow(RangeError);
  });
});

describe('decodeFinalizationMessage robustness', () => {
  it('decodes truncated buffer without throwing (protobufjs default)', () => {
    const dec = decodeFinalizationMessage(new Uint8Array([0x0a, 0x01, 0x41]));
    expect(typeof dec.ual).toBe('string');
  });

  it('round-trip preserves contextGraphId when set', () => {
    const msg = minimalFinalization({ contextGraphId: 'cg-hex' }) as any;
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.contextGraphId).toBe('cg-hex');
  });
});

/**
 * keepRootCopyOnLabel is the gossip-side dual-write toggle introduced in
 * PR #779. Codex r5 flagged that the wire schema flipped from `bool` to a
 * `uint32` tristate sentinel without explicit round-trip coverage —
 * regression risk if a future refactor silently collapsed `false` back into
 * the proto3-default/legacy case (the exact ambiguity that motivated the
 * tristate). These tests pin the encoder ↔ decoder contract and the
 * mixed-mesh decode path for legacy tag-15 `bool` payloads.
 */
describe('keepRootCopyOnLabel tristate wire contract', () => {
  it('round-trips true → KEEP(1) → true', () => {
    const msg = minimalFinalization({ keepRootCopyOnLabel: true }) as any;
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.keepRootCopyOnLabel).toBe(true);
  });

  it('round-trips false → DROP(2) → false', () => {
    // The whole point of the tristate is that explicit `false` survives
    // the wire as a non-default sentinel value. proto3 `bool=false` would
    // be dropped by the encoder and decoded back as `undefined`, which
    // would defeat the "publisher explicitly opted out" signal Codex r4
    // flagged on the explicit-`subContextGraphId === own-CG` flow.
    const msg = minimalFinalization({ keepRootCopyOnLabel: false }) as any;
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.keepRootCopyOnLabel).toBe(false);
  });

  it('round-trips undefined → UNSET(0, omitted) → undefined', () => {
    const msg = minimalFinalization({}) as any;
    expect(msg.keepRootCopyOnLabel).toBeUndefined();
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.keepRootCopyOnLabel).toBeUndefined();
  });

  it('encodes undefined identically to a message that omits the field entirely', () => {
    // Round-trip is the public contract; the byte-level guarantee here
    // is that "field omitted" and "field explicitly undefined" produce
    // the SAME wire output. A future refactor that started encoding
    // `keepRootCopyOnLabel === undefined` as something other than the
    // tristate UNSET sentinel would split the legacy/forward-compat
    // path on mixed-version meshes (some receivers would see UNSET,
    // some KEEP, some DROP). protobufjs happens to serialise `uint32=0`
    // as explicit wire bytes (proto2-style default emission); that's
    // fine — the receiver normalises 0 / unknown / absent all to
    // `undefined`. We assert byte-level equality of undef vs base, and
    // explicit non-equality vs KEEP, so any accidental shift in the
    // encoder shows up.
    const baseBuf  = encodeFinalizationMessage(minimalFinalization({}) as any);
    const undefBuf = encodeFinalizationMessage(
      minimalFinalization({ keepRootCopyOnLabel: undefined }) as any,
    );
    const keepBuf  = encodeFinalizationMessage(
      minimalFinalization({ keepRootCopyOnLabel: true }) as any,
    );
    expect(Buffer.from(undefBuf).equals(Buffer.from(baseBuf))).toBe(true);
    expect(Buffer.from(keepBuf).equals(Buffer.from(baseBuf))).toBe(false);
  });

  it('writes the tristate sentinel on tag 16, never on tag 15 (Codex r6 — retired tag)', () => {
    // Codex r6: tag 15 was briefly the bool variant of this field
    // during intermediate r2/r3/r4 work. A peer running an
    // intermediate build would decode any non-zero tag-15 varint as
    // `bool=true`, so a new sender emitting `DROP_ROOT (2)` on tag 15
    // would be misread as `keepRootCopyOnLabel=true` and the old
    // replica would recreate a root copy the publisher had
    // intentionally deleted. Move the tristate to a fresh tag (16)
    // and reserve tag 15 forever.
    //
    // Tag 16 wire-type 0 (varint) tag bytes are 0x80 0x01 (varint of
    // (16 << 3) | 0 = 128). Tag 15 wire bytes are 0x78 (single byte).
    // After this round, NO encoded message should contain 0x78 with a
    // following varint that looks like the tristate sentinel.
    // Cross-check: a KEEP-encoded message must contain the 0x80 0x01
    // tag bytes, and the prior tag-15 (0x78) byte must not appear in
    // a position that could be parsed as the keepRootCopyOnLabel
    // wire field. (Note: 0x78 is also ASCII 'x', which legitimately
    // appears in string fields like UALs — so we can't assert global
    // absence; we instead pin the encoded length delta.)
    const baseBuf = encodeFinalizationMessage(minimalFinalization({}) as any);
    const keepBuf = encodeFinalizationMessage(
      minimalFinalization({ keepRootCopyOnLabel: true }) as any,
    );
    // A KEEP message has tag bytes 0x80 0x01 followed by value 0x01.
    // protobufjs's emit-default behaviour on tag 16 means baseBuf
    // ALSO contains 0x80 0x01 + value 0x00. So the byte-level diff
    // between baseBuf (UNSET=0) and keepBuf (KEEP=1) is exactly one
    // value byte — confirming we're still on the new tag.
    expect(keepBuf.length).toBe(baseBuf.length);
    // Find the 0x80 0x01 sequence; the subsequent byte holds the
    // sentinel value. Walk back-to-front because tag 16 lives near
    // the end of the message.
    function findSentinelValue(buf: Uint8Array): number | null {
      for (let i = buf.length - 3; i >= 0; i--) {
        if (buf[i] === 0x80 && buf[i + 1] === 0x01) return buf[i + 2];
      }
      return null;
    }
    expect(findSentinelValue(baseBuf)).toBe(0);
    expect(findSentinelValue(keepBuf)).toBe(1);
  });

  it('ignores intermediate-PR tag-15 bool payloads as unknown fields (Codex r6 — no legacy bool reuse)', () => {
    // An intermediate-PR-#779 build would have shipped `bool` on tag 15
    // (`0x78 0x01` for true, `0x78 0x00` for false-but-most-encoders-
    // would-omit). After Codex r6 we permanently retire tag 15: the
    // schema no longer has it, so protobufjs decodes those bytes as
    // unknown-field bytes and the public `keepRootCopyOnLabel` lands
    // on `undefined`. No production peer ever ran an intermediate
    // build, so this is a defence-in-depth pin rather than a real
    // rolling-upgrade bridge — the contract we're protecting is
    // "post-r6 receivers MUST NOT honour tag-15 wire bytes" so a
    // future refactor can't silently re-introduce the unsound legacy
    // bool reuse.
    const tag15TrueBuf  = new Uint8Array([0x78, 0x01]);
    const tag15FalseBuf = new Uint8Array([0x78, 0x00]);
    expect(decodeFinalizationMessage(tag15TrueBuf).keepRootCopyOnLabel).toBeUndefined();
    expect(decodeFinalizationMessage(tag15FalseBuf).keepRootCopyOnLabel).toBeUndefined();
  });

  it('decodes a tag-16 KEEP payload as true (rolling-upgrade bridge for cross-language meshes)', () => {
    // Manually construct the minimum-viable post-r6 payload that a
    // non-protobufjs publisher (protoc-go, prost, …) would emit:
    // just the tristate field on tag 16 with value 1. protobufjs
    // tolerates a partial message; the decoder fills the remaining
    // fields with their type defaults. This pins the cross-language
    // wire compatibility for the keepRootCopyOnLabel signal.
    const buf = new Uint8Array([0x80, 0x01, 0x01]);
    const dec = decodeFinalizationMessage(buf);
    expect(dec.keepRootCopyOnLabel).toBe(true);
  });

  it('clamps unknown forward-compat sentinel values to undefined', () => {
    // Future protocol versions may extend the sentinel (e.g. 3 = a new
    // mode). Today's receivers MUST treat unknowns the same as UNSET so
    // they fall back to the safe no-dual-write path rather than
    // guessing one of KEEP/DROP and risking divergence from the
    // publisher's intent.
    const forwardBuf = new Uint8Array([0x80, 0x01, 0x07]);
    const dec = decodeFinalizationMessage(forwardBuf);
    expect(dec.keepRootCopyOnLabel).toBeUndefined();
  });
});
