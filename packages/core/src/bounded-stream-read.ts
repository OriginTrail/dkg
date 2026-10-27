import type { Stream } from '@libp2p/interface';

/** A local stream byte ceiling, distinct from peer refusal or availability. */
export class ProtocolReadLimitError extends Error {
  readonly code = 'PROTOCOL_READ_LIMIT_EXCEEDED';
  constructor(readonly maxBytes: number) {
    super(`Read limit exceeded (${maxBytes} bytes)`);
    this.name = 'ProtocolReadLimitError';
  }
}

export async function readBoundedStream(
  stream: Stream | AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.subarray());
    total += buf.length;
    if (total > maxBytes) {
      if ('abort' in stream && typeof (stream as Stream).abort === 'function') {
        (stream as Stream).abort(new Error('read limit exceeded'));
      }
      throw new ProtocolReadLimitError(maxBytes);
    }
    chunks.push(buf);
  }
  return concat(chunks);
}


function concat(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
