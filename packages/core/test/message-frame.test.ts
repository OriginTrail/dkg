import { describe, it, expect } from 'vitest';
import {
  FrameType,
  encodeFrame,
  encodeVarint,
  tryDecodeVarint,
  decodeFrames,
  DEFAULT_MAX_FRAME_BYTES,
} from '../src/message-frame.js';

describe('encodeVarint / tryDecodeVarint', () => {
  it('round-trips small values in one byte', () => {
    for (const v of [0, 1, 5, 0x7f]) {
      const buf = encodeVarint(v);
      expect(buf.length).toBe(1);
      const dec = tryDecodeVarint(buf, 0);
      expect(dec).toEqual({ value: v, bytesRead: 1 });
    }
  });

  it('round-trips two-byte values', () => {
    for (const v of [0x80, 0x3fff, 1234]) {
      const buf = encodeVarint(v);
      expect(buf.length).toBe(2);
      const dec = tryDecodeVarint(buf, 0);
      expect(dec).toEqual({ value: v, bytesRead: 2 });
    }
  });

  it('round-trips multi-byte values up to 2^32-1', () => {
    for (const v of [0x1fffff, 0xffffffff]) {
      const buf = encodeVarint(v);
      const dec = tryDecodeVarint(buf, 0);
      expect(dec).toEqual({ value: v, bytesRead: buf.length });
    }
  });

  it('returns null when the buffer ends mid-varint', () => {
    // 0x80 continuation byte with nothing after it — partial varint.
    expect(tryDecodeVarint(new Uint8Array([0x80]), 0)).toBeNull();
    expect(tryDecodeVarint(new Uint8Array([]), 0)).toBeNull();
  });

  it('throws on overlong varint', () => {
    const overlong = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(() => tryDecodeVarint(overlong, 0)).toThrow(/exceeds 5 bytes/);
  });

  it('throws on out-of-range input to encodeVarint', () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError);
    expect(() => encodeVarint(1.5)).toThrow(RangeError);
    expect(() => encodeVarint(0xffffffff + 1)).toThrow(RangeError);
  });
});

describe('encodeFrame', () => {
  it('encodes PING as 2 bytes (length=1, type=0x04, no payload)', () => {
    const f = encodeFrame(FrameType.PING);
    expect(Array.from(f)).toEqual([0x01, FrameType.PING]);
  });

  it('encodes a REQUEST frame with payload', () => {
    const payload = new TextEncoder().encode('hi');
    const f = encodeFrame(FrameType.REQUEST, payload);
    // body = type(1) + 'hi'(2) = 3 bytes; length-prefix = 0x03
    expect(Array.from(f)).toEqual([0x03, FrameType.REQUEST, 0x68, 0x69]);
  });

  it('handles a large payload without throwing', () => {
    const payload = new Uint8Array(200_000);
    payload.fill(0xab);
    const f = encodeFrame(FrameType.RESPONSE, payload);
    // length-prefix uses 3 bytes for 200_001
    expect(f.length).toBe(3 + 1 + 200_000);
  });
});

async function* arrAsAsync<T>(arr: T[]): AsyncGenerator<T, void, void> {
  for (const v of arr) yield v;
}

describe('decodeFrames', () => {
  it('decodes a sequence of frames from one contiguous buffer', async () => {
    const reqA = encodeFrame(FrameType.REQUEST, new TextEncoder().encode('A'));
    const reqB = encodeFrame(FrameType.REQUEST, new TextEncoder().encode('BB'));
    const ping = encodeFrame(FrameType.PING);
    const merged = new Uint8Array(reqA.length + reqB.length + ping.length);
    merged.set(reqA, 0);
    merged.set(reqB, reqA.length);
    merged.set(ping, reqA.length + reqB.length);

    const frames = [];
    for await (const f of decodeFrames(arrAsAsync([merged]))) {
      frames.push(f);
    }
    expect(frames.map((f) => f.type)).toEqual([
      FrameType.REQUEST,
      FrameType.REQUEST,
      FrameType.PING,
    ]);
    expect(new TextDecoder().decode(frames[0].payload)).toBe('A');
    expect(new TextDecoder().decode(frames[1].payload)).toBe('BB');
    expect(frames[2].payload.length).toBe(0);
  });

  it('decodes frames split across chunk boundaries (mid-length, mid-body)', async () => {
    const payload = new Uint8Array(200);
    payload.fill(0x42);
    const frame = encodeFrame(FrameType.RESPONSE, payload);

    // Split into 1-byte chunks to stress every boundary.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < frame.length; i++) {
      chunks.push(frame.slice(i, i + 1));
    }
    const frames = [];
    for await (const f of decodeFrames(arrAsAsync(chunks))) {
      frames.push(f);
    }
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(FrameType.RESPONSE);
    expect(frames[0].payload.length).toBe(200);
    expect(frames[0].payload[0]).toBe(0x42);
  });

  it('handles empty chunks emitted at backpressure boundaries', async () => {
    const f = encodeFrame(FrameType.PONG);
    const chunks: Uint8Array[] = [
      new Uint8Array(0),
      f.slice(0, 1),
      new Uint8Array(0),
      f.slice(1),
    ];
    const frames = [];
    for await (const x of decodeFrames(arrAsAsync(chunks))) {
      frames.push(x);
    }
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(FrameType.PONG);
  });

  it('throws when a frame body exceeds the configured cap', async () => {
    // Length prefix says 10 bytes but we cap at 4.
    const length = encodeVarint(10);
    const stub = new Uint8Array(length.length + 10);
    stub.set(length, 0);
    await expect(async () => {
      const frames = [];
      for await (const f of decodeFrames(arrAsAsync([stub]), 4)) frames.push(f);
    }).rejects.toThrow(/exceeds cap/);
  });

  it('throws when stream ends mid-frame', async () => {
    // Promise length=5, deliver only 3 bytes total.
    const partial = new Uint8Array([0x05, 0x01, 0xaa]);
    await expect(async () => {
      const frames = [];
      for await (const f of decodeFrames(arrAsAsync([partial]))) frames.push(f);
    }).rejects.toThrow(/ended mid-frame/);
  });

  it('returns cleanly on EOF before any frame bytes', async () => {
    const frames = [];
    for await (const f of decodeFrames(arrAsAsync<Uint8Array>([]))) frames.push(f);
    expect(frames).toEqual([]);
  });

  it('default cap is 10 MiB', () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(10 * 1024 * 1024);
  });
});
