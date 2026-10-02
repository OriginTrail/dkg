import { describe, expect, it, vi } from 'vitest';
import {
  EXACT_BATCH_BATCH_INDEX, EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_MAX_FRAME_BYTES,
  EXACT_BATCH_MAX_CHUNKS_PER_ASSET, encodeExactBatchFrame, decodeExactBatchFrames,
  type ExactBatchFrame,
} from '../src/experimental-exact-batch-wire.js';
const encoder = new TextEncoder();
const frame = (kind: number, assetIndex = 0, sequence = 0, payload = new Uint8Array(0)): ExactBatchFrame => ({ kind, assetIndex, sequence, payload });
const meta = (index = 0) => frame(K.META, index, 0, encoder.encode('<urn:meta> <urn:p> "proof input" .\n'));
const data = (index = 0, sequence = 0, payload = encoder.encode('<urn:s> <urn:p> "body" .\n')) => frame(K.DATA, index, sequence, payload);
const end = (index = 0, chunks = 1) => frame(K.ASSET_END, index, chunks);
const eof = (count = 1) => frame(K.BATCH_END, EXACT_BATCH_BATCH_INDEX, count);
const refuse = (code: string) => frame(K.REFUSE, EXACT_BATCH_BATCH_INDEX, 0, encoder.encode(code));
async function* chunks(bytes: Uint8Array, size = bytes.byteLength) { for (let n = 0; n < bytes.byteLength; n += size) yield bytes.subarray(n, n + size); }
async function decoded(bytes: Uint8Array, size?: number) { const result: ExactBatchFrame[] = []; for await (const f of decodeExactBatchFrames(chunks(bytes, size))) result.push(f); return result; }
function joined(frames: ExactBatchFrame[]) {
  const wires = frames.map(encodeExactBatchFrame), result = new Uint8Array(wires.reduce((n, bytes) => n + bytes.byteLength, 0));
  let offset = 0; for (const wire of wires) { result.set(wire, offset); offset += wire.byteLength; } return result;
}
describe('experimental exact batch bounded framing', () => {
  it('decodes split headers and payloads without treating chunk boundaries as frames', async () => {
    const frames = [frame(K.REQUEST, 255, 0, encoder.encode('{"authorizedEnvelope":"input"}')), meta(), data(), end(), eof()];
    const bytes = joined(frames);
    for (const size of [1, 7, 16, 63, bytes.byteLength]) expect(await decoded(bytes, size)).toEqual(frames);
  });
  it('checks the first REQUEST limit before requesting any body bytes', async () => {
    const header = encodeExactBatchFrame(frame(K.REQUEST, 255, 0, encoder.encode('x'))).slice(0, 16);
    new DataView(header.buffer).setUint32(12, 8193);
    const next = vi.fn();
    async function* source() { yield header; next(); yield new Uint8Array(8193); }
    await expect((async () => { for await (const _ of decodeExactBatchFrames(source())) { /* no valid frame */ } })()).rejects.toThrow('request');
    expect(next).not.toHaveBeenCalled();
  });
  it.each([
    ['magic', 0, 0], ['reserved', 6, 1], ['unknown kind', 4, 8], ['index', 5, 10],
  ])('rejects malformed %s before body allocation', async (_, offset, value) => {
    const bytes = encodeExactBatchFrame(meta()); bytes[offset] = value;
    await expect(decoded(bytes)).rejects.toThrow();
  });
  it('rejects giant payload lengths, empty DATA and excessive chunk counts', async () => {
    const bytes = encodeExactBatchFrame(data()); new DataView(bytes.buffer).setUint32(12, 0xffff_ffff);
    await expect(decoded(bytes.subarray(0, 16))).rejects.toThrow('header');
    expect(() => encodeExactBatchFrame(frame(K.DATA))).toThrow('data');
    expect(() => encodeExactBatchFrame(data(0, EXACT_BATCH_MAX_CHUNKS_PER_ASSET))).toThrow('data');
  });
  it.each([1, 15, 16, 20])('rejects truncation at %i bytes', async size => { await expect(decoded(encodeExactBatchFrame(meta()).slice(0, size))).rejects.toThrow('Truncated'); });
  it('rejects non-byte sources and honors cancellation at frame boundaries', async () => {
    async function* invalid() { yield 'text' as unknown as Uint8Array; }
    await expect((async () => { for await (const _ of decodeExactBatchFrames(invalid())) { /* invalid */ } })()).rejects.toThrow('bytes');
    const controller = new AbortController(); controller.abort();
    await expect((async () => { for await (const _ of decodeExactBatchFrames(chunks(encodeExactBatchFrame(meta())), { signal: controller.signal })) { /* aborted */ } })()).rejects.toThrow();
  });
  it('allows only the closed wire refusal vocabulary', async () => {
    expect(await decoded(encodeExactBatchFrame(refuse('RESOURCE_LIMIT')))).toEqual([refuse('RESOURCE_LIMIT')]);
    expect(() => encodeExactBatchFrame(refuse('raw sensitive error'))).toThrow('Unknown');

  });
});


describe('fixed exact-batch wire byte compatibility', () => {
  it.each([
    [frame(K.REQUEST, 255, 0, encoder.encode('x')), '444b423101ff0000000000000000000178'],
    [frame(K.META, 0, 0, encoder.encode('m')), '444b42310200000000000000000000016d'],
    [frame(K.DATA, 9, 1023, encoder.encode('d')), '444b423103090000000003ff0000000164'],
    [frame(K.ASSET_END, 0, 1), '444b4231040000000000000100000000'],
    [frame(K.ACK, 0, 1), '444b4231050000000000000100000000'],
    [frame(K.BATCH_END, 255, 10), '444b423106ff00000000000a00000000'],
    [refuse('DENIED'), '444b423107ff0000000000000000000644454e494544'],
  ])('preserves the frozen bytes for kind %j', async (item, hex) => {
    const bytes = Uint8Array.from(hex.match(/../g)!.map(byte => Number.parseInt(byte, 16)));
    expect(encodeExactBatchFrame(item)).toEqual(bytes);
    expect(await decoded(bytes, 1)).toEqual([item]);
  });
  it('keeps the inclusive payload allowance and header size', async () => {
    const item = data(9, 1023, new Uint8Array(EXACT_BATCH_MAX_FRAME_BYTES));
    const bytes = encodeExactBatchFrame(item);
    expect(bytes.byteLength).toBe(65_552);
    expect(await decoded(bytes, 127)).toEqual([item]);
    expect(() => encodeExactBatchFrame(data(9, 1023, new Uint8Array(EXACT_BATCH_MAX_FRAME_BYTES + 1)))).toThrow('header');
  });
});
