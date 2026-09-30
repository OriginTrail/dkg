import { describe, expect, it, vi } from 'vitest';
import {
  EXACT_BATCH_BATCH_INDEX, EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_MAX_FRAME_BYTES,
  EXACT_BATCH_MAX_CHUNKS_PER_ASSET, ExactBatchReceiveWindow, ExactBatchSendWindow,
  decodeExactBatchAsset, decodeExactBatchFrames, encodeExactBatchFrame, isRecoverableExactBatchRefusal,
  type ExactBatchFrame,
} from '../src/sync/exact-batch-stream-contract.js';
import { EXACT_SYNC_GZIP_ENCODING, encodeNegotiatedExactSyncResponse } from '../src/sync/wire-compression.js';

const encoder = new TextEncoder();
const UALS = [1, 2, 3].map(n => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${n}`);
const frame = (kind: number, assetIndex = 0, sequence = 0, payload = new Uint8Array(0)): ExactBatchFrame => ({ kind, assetIndex, sequence, payload });
const meta = (index = 0) => frame(K.META, index, 0, encoder.encode('<urn:meta> <urn:p> "proof input" .\n'));
const data = (index = 0, sequence = 0, payload = encoder.encode('<urn:s> <urn:p> "body" .\n')) => frame(K.DATA, index, sequence, payload);
const end = (index = 0, chunks = 1) => frame(K.ASSET_END, index, chunks);
const eof = (count = 1) => frame(K.BATCH_END, EXACT_BATCH_BATCH_INDEX, count);
const ack = (index = 0, chunks = 1) => frame(K.ACK, index, chunks);
const refuse = (code: string) => frame(K.REFUSE, EXACT_BATCH_BATCH_INDEX, 0, encoder.encode(code));
async function* chunks(bytes: Uint8Array, size = bytes.byteLength) { for (let n = 0; n < bytes.byteLength; n += size) yield bytes.subarray(n, n + size); }
async function decoded(bytes: Uint8Array, size?: number) { const result: ExactBatchFrame[] = []; for await (const f of decodeExactBatchFrames(chunks(bytes, size))) result.push(f); return result; }
function joined(frames: ExactBatchFrame[]) {
  const wires = frames.map(encodeExactBatchFrame), result = new Uint8Array(wires.reduce((n, bytes) => n + bytes.byteLength, 0));
  let offset = 0; for (const wire of wires) { result.set(wire, offset); offset += wire.byteLength; } return result;
}
function receiveAsset(window: ExactBatchReceiveWindow, index = 0, payload?: Uint8Array) {
  window.accept(meta(index)); window.accept(data(index, 0, payload)); window.accept(end(index));
}
function sendAsset(window: ExactBatchSendWindow, index = 0) { window.acceptSent(meta(index)); window.acceptSent(data(index)); window.acceptSent(end(index)); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

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
  it('allows only closed refusal codes and restricts legacy retry eligibility', async () => {
    expect(await decoded(encodeExactBatchFrame(refuse('RESOURCE_LIMIT')))).toEqual([refuse('RESOURCE_LIMIT')]);
    expect(() => encodeExactBatchFrame(refuse('raw sensitive error'))).toThrow('Unknown');
    for (const code of ['RESOURCE_LIMIT', 'UNSUPPORTED', 'ASSET_MISSING'] as const) expect(isRecoverableExactBatchRefusal(code)).toBe(true);
    expect(isRecoverableExactBatchRefusal('DENIED')).toBe(false); expect(isRecoverableExactBatchRefusal('SOURCE_CHANGED')).toBe(false);
  });
});

describe('exact batch receiver ownership and commit credit', () => {
  it('canonicalizes distinct valid selections and rejects invalid caps/windows', () => {
    expect(new ExactBatchReceiveWindow({ assetUals: [UALS[1]!, UALS[0]!] }).assetUals).toEqual(UALS.slice(0, 2));
    for (const assetUals of [[], [UALS[0]!, UALS[0]!], ['invalid'], Array.from({ length: 11 }, (_, n) => UALS[n % 3]!)]) expect(() => new ExactBatchReceiveWindow({ assetUals })).toThrow();
    expect(() => new ExactBatchReceiveWindow({ assetUals: [UALS[0]!], windowSize: 3 as 1 })).toThrow('window');
  });
  it('requires metadata, contiguous DATA and matching explicit asset-end', () => {
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] });
    expect(() => window.accept(data())).toThrow('order'); window.accept(meta());
    expect(() => window.accept(data(0, 1))).toThrow('order'); expect(() => window.accept(end())).toThrow('order');
    window.accept(data()); expect(() => window.accept(end(0, 2))).toThrow('order'); window.accept(end());
    expect(window.takeReady()?.chunkCount).toBe(1); expect(window.takeReady()).toBeUndefined();
  });
  it('enforces inclusive4MiB per-KA accumulation independently of frame cap', () => {
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] }); window.accept(meta());
    const payload = new Uint8Array(EXACT_BATCH_MAX_FRAME_BYTES);
    for (let sequence = 0; sequence < 64; sequence++) window.accept(data(0, sequence, payload));
    expect(() => window.accept(data(0, 64, new Uint8Array(1)))).toThrow('physical wire');
    window.accept(end(0, 64)); expect(window.takeReady()?.dataBytes.byteLength).toBe(4 * 1024 * 1024);
  });
  it('window1 does not allow the next asset until verified atomic commit settles', async () => {
    const window = new ExactBatchReceiveWindow({ assetUals: UALS.slice(0, 2) }); receiveAsset(window);
    expect(() => window.accept(meta(1))).toThrow('window'); const asset = window.takeReady()!;
    const gate = deferred(), callback = vi.fn(() => gate.promise); const operation = window.commitAsset(asset, callback);
    expect(callback).toHaveBeenCalledOnce(); expect(window.committedCount).toBe(0);
    expect(() => window.accept(meta(1))).toThrow('window'); gate.resolve(); expect(await operation).toEqual(ack());
    receiveAsset(window, 1); expect(window.takeReady()?.assetIndex).toBe(1);
  });
  it('window2 overlaps one compressed next asset, never a third or second verifier', async () => {
    const window = new ExactBatchReceiveWindow({ assetUals: UALS, windowSize: 2 }); receiveAsset(window);
    const first = window.takeReady()!, gate = deferred(); const operation = window.commitAsset(first, () => gate.promise);
    receiveAsset(window, 1); expect(window.retainedAssets).toBe(2); expect(window.takeReady()).toBeUndefined();
    expect(() => window.accept(meta(2))).toThrow('window'); gate.resolve(); await operation;
    const second = window.takeReady()!; receiveAsset(window, 2); expect(window.retainedAssets).toBe(2);
    await window.commitAsset(second, async () => {}); await window.commitAsset(window.takeReady()!, async () => {});
    expect(window.complete).toBe(false); window.accept(eof(3)); expect(window.complete).toBe(true);
  });
  it('does not accept forged tickets or generate ACK after failed verification', async () => {
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] }); receiveAsset(window); const asset = window.takeReady()!;
    const callback = vi.fn(async () => {}); expect(() => window.commitAsset({ ...asset }, callback)).toThrow('Unowned'); expect(callback).not.toHaveBeenCalled();
    await expect(window.commitAsset(asset, async () => { throw new Error('canonical root mismatch'); })).rejects.toThrow('root mismatch');
    expect(window.committedCount).toBe(0); expect(window.complete).toBe(false); expect(window.retainedAssets).toBe(0);
    expect(() => window.accept(eof())).toThrow('closed');
  });
  it('close awaits physical commit settlement and suppresses ACK after cancellation', async () => {
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] }); receiveAsset(window);
    const gate = deferred(), operation = window.commitAsset(window.takeReady()!, () => gate.promise);
    const rejected = expect(operation).rejects.toThrow('closed'); let settled = false;
    const closing = window.close().then(() => { settled = true; }); await Promise.resolve();
    expect(settled).toBe(false); expect(window.retainedAssets).toBe(1); gate.resolve(); await rejected; await closing;
    expect(window.committedCount).toBe(1); expect(window.retainedAssets).toBe(0); expect(window.complete).toBe(false);
  });
  it('abort during an atomic write retains ownership until that write settles', async () => {
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] }); receiveAsset(window);
    const gate = deferred(), controller = new AbortController();
    const operation = window.commitAsset(window.takeReady()!, () => gate.promise, { signal: controller.signal }); const rejected = expect(operation).rejects.toThrow();
    controller.abort(); expect(window.retainedAssets).toBe(1); expect(window.committedCount).toBe(0);
    gate.resolve(); await rejected; expect(window.committedCount).toBe(1); expect(window.complete).toBe(false);
  });
  it('explicit end is required and cannot assert completion of missing/uncommitted assets', async () => {
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] }); expect(() => window.accept(eof())).toThrow('Premature');
    receiveAsset(window); window.accept(eof()); expect(window.complete).toBe(false);
    await window.commitAsset(window.takeReady()!, async () => {}); expect(window.complete).toBe(true);
    expect(() => window.accept(data())).toThrow('closed');
  });
  it('refusal stops new bodies and requires close before fresh legacy work', async () => {
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] }); window.accept(refuse('ASSET_MISSING'));
    expect(window.refusal).toBe('ASSET_MISSING'); expect(window.complete).toBe(false); expect(window.takeReady()).toBeUndefined();
    expect(() => window.accept(meta())).toThrow('closed'); await window.close(); expect(window.retainedAssets).toBe(0);
  });
  it('uses existing bounded gzip decoding and preserves unchanged per-KA bytes', async () => {
    const plain = encoder.encode(`<urn:s> <urn:p> "${'same value '.repeat(10_000)}" .\n`);
    const encoded = await encodeNegotiatedExactSyncResponse(plain, { request: { responseEncoding: EXACT_SYNC_GZIP_ENCODING, phase: 'data', assetUals: [UALS[0]!] } });
    const window = new ExactBatchReceiveWindow({ assetUals: [UALS[0]!] }); receiveAsset(window, 0, encoded);
    const asset = window.takeReady()!; expect((await decodeExactBatchAsset(asset)).bytes).toEqual(plain);
    const malformed = { ...asset, dataBytes: encoded.slice() }; new DataView(malformed.dataBytes.buffer).setUint32(8, 16 * 1024 * 1024 + 1);
    await expect(decodeExactBatchAsset(malformed)).rejects.toThrow('lengths');
  });
});

describe('exact batch sender commit ACK window', () => {
  it('blocks window1 on matching physical commit ACK and rejects premature/duplicate/wrong ACK', () => {
    const window = new ExactBatchSendWindow({ assetCount: 2 }); window.acceptSent(meta());
    expect(() => window.acceptAck(ack())).toThrow('ACK'); window.acceptSent(data()); window.acceptSent(end());
    expect(window.canStartAsset).toBe(false); expect(() => window.acceptSent(meta(1))).toThrow('window');
    expect(() => window.acceptAck(ack(1))).toThrow('ACK'); expect(() => window.acceptAck(ack(0, 2))).toThrow('ACK');
    window.acceptAck(ack()); expect(window.canStartAsset).toBe(true); expect(() => window.acceptAck(ack())).toThrow('ACK');
    sendAsset(window, 1); window.acceptSent(eof(2)); expect(window.complete).toBe(false); window.acceptAck(ack(1)); expect(window.complete).toBe(true);
  });
  it('window2 allows one next export while waiting for previous commit, with ordered credit', () => {
    const window = new ExactBatchSendWindow({ assetCount: 3, windowSize: 2 }); sendAsset(window); sendAsset(window, 1);
    expect(window.canStartAsset).toBe(false); expect(() => window.acceptSent(meta(2))).toThrow('window'); expect(() => window.acceptAck(ack(1))).toThrow('ACK');
    window.acceptAck(ack()); expect(window.canStartAsset).toBe(true); sendAsset(window, 2); window.acceptAck(ack(1)); window.acceptSent(eof(3));
    expect(window.complete).toBe(false); window.acceptAck(ack(2)); expect(window.complete).toBe(true); window.close(); expect(window.complete).toBe(false);
  });
});
