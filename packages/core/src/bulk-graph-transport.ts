// SPDX-License-Identifier: Apache-2.0
import type { Stream } from '@libp2p/interface';
import { type ProtocolRouter, type DuplexStreamOptions } from './protocol-router.js';
import { BULK_GRAPH_KIND as K, BULK_GRAPH_PROTOCOL, BULK_GRAPH_REQUEST_BYTES,
  decodeBulkGraphFrames, encodeBulkGraphFrame, type BulkGraphFrame } from './bulk-graph-wire.js';

export class BulkGraphSession {
  private readonly frames: AsyncGenerator<BulkGraphFrame>;
  constructor(private readonly stream: Stream, readonly signal: AbortSignal) {
    this.frames = decodeBulkGraphFrames({ async *[Symbol.asyncIterator]() {
      let total = 0;
      for await (const chunk of stream) {
        // 100 MB DATA plus bounded per-asset metadata, framing and control.
        total += chunk.byteLength;
        if (total > 240_000_000) throw new RangeError('Bulk graph wire allowance exceeded');
        yield chunk.subarray();
      }
    } }, signal);
  }
  async next(): Promise<BulkGraphFrame> {
    this.signal.throwIfAborted();
    const timeout = setTimeout(() => this.abort(new Error('Bulk graph idle deadline exceeded')), 120_000);
    let frame: IteratorResult<BulkGraphFrame>;
    try { frame = await this.frames.next(); } finally { clearTimeout(timeout); }
    this.signal.throwIfAborted();
    if (frame.done) throw new Error('Bulk graph stream ended early');
    return frame.value;
  }
  async send(frame: BulkGraphFrame): Promise<void> {
    this.signal.throwIfAborted();
    if (this.stream.writableNeedsDrain) await this.stream.onDrain({ signal: this.signal });
    if (!this.stream.send(encodeBulkGraphFrame(frame))) await this.stream.onDrain({ signal: this.signal });
    this.signal.throwIfAborted();
  }
  abort(error: unknown): void { this.stream.abort(error instanceof Error ? error : new Error('Bulk graph cancelled')); }
  /** Called only after the router physically closes/aborts the stream. */
  async dispose(): Promise<void> { await this.frames.return(undefined).catch(() => undefined); }
}
export function bulkGraphTransportOptions(timeoutMs: number, signal?: AbortSignal): DuplexStreamOptions & { maxRequestBytes: number } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new RangeError('Invalid bulk graph deadline');
  return { timeoutMs, signal, maxRequestBytes: BULK_GRAPH_REQUEST_BYTES, maxReadBufferBytes: 2 * (BULK_GRAPH_REQUEST_BYTES + 20) };
}
export async function exchangeBulkGraph<T>(router: ProtocolRouter, peer: string, request: Uint8Array,
  options: DuplexStreamOptions, consume: (session: BulkGraphSession) => Promise<T>): Promise<T> {
  let session: BulkGraphSession | undefined;
  try {
    return await router.withDuplexStream(peer, BULK_GRAPH_PROTOCOL, options, async (stream, signal) => {
      session = new BulkGraphSession(stream, signal);
      await session.send({ kind: K.REQUEST, index: 0, sequence: 0, payload: request });
      return consume(session);
    });
  } finally { await session?.dispose(); }
}
export function registerBulkGraphResponder<T>(router: ProtocolRouter,
  authorize: (bytes: Uint8Array, peer: string, signal: AbortSignal) => Promise<T>,
  respond: (request: T, session: BulkGraphSession, peer: string) => Promise<void>): void {
  router.registerDuplexStream(BULK_GRAPH_PROTOCOL, async (stream, signal) => {
    const session = new BulkGraphSession(stream, signal);
    try {
      const first = await session.next();
      if (first.kind !== K.REQUEST || first.index !== 0 || first.sequence !== 0) throw new Error('Bulk graph request missing');
      return { requestData: first.payload, continuation: session, dispose: () => session.dispose() };
    } catch (error) {
      stream.abort(error instanceof Error ? error : new Error('Invalid bulk graph request'));
      await session.dispose(); throw error;
    }
  }, async ({ requestData, continuation, peerId, signal }) => {
    const authorized = await authorize(requestData, peerId, signal);
    await respond(authorized, continuation, peerId);
  }, bulkGraphTransportOptions(3_600_000));
}
