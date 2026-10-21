import { closeSync, openSync, readSync } from 'node:fs';
import type oxigraph from 'oxigraph';

const SNAPSHOT_CHUNK_BYTES = 64 * 1024;

/** Read errors must not quarantine a valid snapshot as malformed RDF. */
export class OxigraphSnapshotReadError extends Error {
  constructor(path: string, cause: unknown) {
    super(`OxigraphStore: failed to read persist file ${path}: ${String(cause)}`, { cause });
    this.name = 'OxigraphSnapshotReadError';
  }
}

/** One parser consumes all chunks, retaining blank-node identity and UTF-8 state. */
export function loadOxigraphSnapshot(store: oxigraph.Store, path: string): void {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (cause) {
    throw new OxigraphSnapshotReadError(path, cause);
  }
  let readFailure: OxigraphSnapshotReadError | undefined;
  let failure: { cause: unknown } | undefined;
  try {
    // The WASM parser wraps iterator exceptions as generic errors. Retain the
    // actual I/O failure outside it so hydration never mistakes it for bad RDF.
    store.load(readSnapshotChunks(fd, path, (error) => { readFailure = error; }), {
      format: 'application/n-quads',
    });
  } catch (cause) {
    failure = { cause: readFailure ?? cause };
  }
  try {
    closeSync(fd);
  } catch (cause) {
    failure ??= { cause: new OxigraphSnapshotReadError(path, cause) };
  }
  if (failure) throw failure.cause;
}

function* readSnapshotChunks(
  fd: number,
  path: string,
  onReadFailure: (error: OxigraphSnapshotReadError) => void,
): Generator<Uint8Array> {
  const buffer = Buffer.allocUnsafe(SNAPSHOT_CHUNK_BYTES);
  for (;;) {
    let count: number;
    try {
      count = readSync(fd, buffer, 0, buffer.length, null);
    } catch (cause) {
      const error = new OxigraphSnapshotReadError(path, cause);
      onReadFailure(error);
      throw error;
    }
    if (count === 0) return;
    // Store.load consumes each input synchronously before requesting the next.
    yield buffer.subarray(0, count);
  }
}

/**
 * Serialize the captured native snapshot without one string for the whole store.
 * Oxigraph's Quad.toString is its N-Quads term serializer, without the final dot.
 * The chunk bound excludes a single larger quad: individual RDF terms still need
 * to fit in JavaScript strings. The native quad array itself scales with count.
 */
export function* serializeOxigraphSnapshot(quads: readonly oxigraph.Quad[]): Generator<string> {
  let chunk = '';
  let bytes = 0;
  for (const quad of quads) {
    const line = `${quad.toString()} .\n`;
    const lineBytes = Buffer.byteLength(line);
    if (bytes > 0 && bytes + lineBytes > SNAPSHOT_CHUNK_BYTES) {
      yield chunk;
      chunk = '';
      bytes = 0;
    }
    chunk += line;
    bytes += lineBytes;
    if (bytes >= SNAPSHOT_CHUNK_BYTES) {
      yield chunk;
      chunk = '';
      bytes = 0;
    }
  }
  if (bytes > 0) yield chunk;
}
