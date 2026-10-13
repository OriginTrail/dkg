// SPDX-License-Identifier: Apache-2.0
/** Incremental assembly only. Protocol parsers validate lengths before allocation. */
export async function* decodeFixedHeaderFrames<Header, Frame>(
  source: AsyncIterable<Uint8Array>,
  options: {
    headerBytes: number;
    parseHeader: (bytes: Uint8Array) => { value: Header; length: number };
    complete: (header: Header, payload: Uint8Array) => Frame;
    bytesError: string;
    truncatedError: string;
    signal?: AbortSignal;
  },
): AsyncGenerator<Frame> {
  const header = new Uint8Array(options.headerBytes);
  let headerUsed = 0;
  let pending: { value: Header; payload: Uint8Array; used: number } | undefined;
  for await (const chunk of source) {
    options.signal?.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) throw new TypeError(options.bytesError);
    let offset = 0;
    while (offset < chunk.byteLength) {
      options.signal?.throwIfAborted();
      if (!pending) {
        const take = Math.min(header.length - headerUsed, chunk.length - offset);
        header.set(chunk.subarray(offset, offset + take), headerUsed);
        headerUsed += take; offset += take;
        if (headerUsed < header.length) continue;
        const parsed = options.parseHeader(header);
        pending = { value: parsed.value, payload: new Uint8Array(parsed.length), used: 0 };
      }
      const take = Math.min(pending.payload.length - pending.used, chunk.length - offset);
      pending.payload.set(chunk.subarray(offset, offset + take), pending.used);
      pending.used += take; offset += take;
      // Zero-byte controls complete immediately, including at a chunk boundary.
      if (pending.used === pending.payload.length) {
        const frame = options.complete(pending.value, pending.payload);
        pending = undefined; headerUsed = 0;
        yield frame;
      }
    }
  }
  options.signal?.throwIfAborted();
  if (headerUsed || pending) throw new Error(options.truncatedError);
}
