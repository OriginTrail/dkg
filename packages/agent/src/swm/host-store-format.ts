/**
 * On-disk format of the SWM host-mode store (host-mode-store.ts): where a CG's
 * files live and how its append-only log is read and written. Pure functions
 * and one path helper, no I/O.
 *
 * Layout: one `<key>.log` and one `<key>.meta` per CG in the store's data
 * directory, where `<key>` is the URL-safe base64 of sha256(contextGraphId), so
 * an arbitrary user-supplied CG id maps to a safe file name.
 *
 * A log is a sequence of frames:
 *   [8-byte BE timestampMs] [8-byte BE seqno] [4-byte BE len] [len bytes]
 *
 * Every reader walks the frames the same way: a frame whose header does not fit
 * in the remaining bytes, or whose length overruns the buffer, ends the walk
 * (the torn tail of a crashed append). Those trailing bytes were never
 * servable, which is why the store may truncate them away.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SwmHostModeEntry } from './host-store-types.js';

export const ENTRY_HEADER_BYTES = 8 + 8 + 4;

/** File naming of one store instance: a data directory and the CG-id to file-name mapping. */
export class HostStoreLayout {
  constructor(readonly dataDir: string) {}

  cgKey(contextGraphId: string): string {
    return createHash('sha256').update(contextGraphId).digest('base64url');
  }

  logPath(contextGraphId: string): string {
    return path.join(this.dataDir, `${this.cgKey(contextGraphId)}.log`);
  }

  metaPath(contextGraphId: string): string {
    return path.join(this.dataDir, `${this.cgKey(contextGraphId)}.meta`);
  }
}

/** One frame (header plus envelope bytes) as it is appended to a log. */
export function encodeFrame(timestampMs: number, seqno: number, envelopeBytes: Uint8Array): Buffer {
  const header = Buffer.alloc(ENTRY_HEADER_BYTES);
  header.writeBigUInt64BE(BigInt(timestampMs), 0);
  header.writeBigUInt64BE(BigInt(seqno), 8);
  header.writeUInt32BE(envelopeBytes.length, 16);
  return Buffer.concat([header, Buffer.from(envelopeBytes)]);
}

/**
 * Walk the frames of a log buffer. `validLength` is the offset just past the
 * last complete frame; any bytes after it are an unparseable tail (a partial
 * header, or a header whose length overruns the file).
 */
export function scanLogFrames(buf: Buffer): { lastSeqno: number; validLength: number } {
  let lastSeqno = 0;
  let offset = 0;
  while (offset + ENTRY_HEADER_BYTES <= buf.length) {
    const seqno = Number(buf.readBigUInt64BE(offset + 8));
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + ENTRY_HEADER_BYTES + len;
    if (end > buf.length) break;
    if (seqno > lastSeqno) lastSeqno = seqno;
    offset = end;
  }
  return { lastSeqno, validLength: offset };
}

/**
 * The entries of a log with seqno strictly greater than `sinceSeqno`, in log
 * (seqno-ascending) order, at most `limit` of them when given.
 */
export function readEntriesSince(buf: Buffer, sinceSeqno: number, limit?: number): SwmHostModeEntry[] {
  const out: SwmHostModeEntry[] = [];
  let offset = 0;
  while (offset + ENTRY_HEADER_BYTES <= buf.length) {
    const timestampMs = Number(buf.readBigUInt64BE(offset));
    const seqno = Number(buf.readBigUInt64BE(offset + 8));
    const len = buf.readUInt32BE(offset + 16);
    const payloadStart = offset + ENTRY_HEADER_BYTES;
    const payloadEnd = payloadStart + len;
    if (payloadEnd > buf.length) {
      break;
    }
    if (seqno > sinceSeqno) {
      out.push({
        seqno,
        timestampMs,
        envelopeBytes: new Uint8Array(buf.subarray(payloadStart, payloadEnd)),
      });
      if (limit !== undefined && out.length >= limit) break;
    }
    offset = payloadEnd;
  }
  return out;
}

/** The number of complete frames in a log buffer. */
export function countFrames(buf: Buffer): number {
  let offset = 0;
  let entries = 0;
  while (offset + ENTRY_HEADER_BYTES <= buf.length) {
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + ENTRY_HEADER_BYTES + len;
    if (end > buf.length) break;
    entries += 1;
    offset = end;
  }
  return entries;
}

/** The byte range `[start, end)` of one complete frame in a log buffer. */
export interface FrameRange {
  start: number;
  end: number;
}

/**
 * What a prune keeps of a log: the frames whose timestamp is at or after
 * `ttlCutoff`, minus the oldest of those until their total size fits
 * `perCgByteCap` (FIFO eviction). `bytesPruned` is the buffer length minus what
 * is kept, so a torn tail counts as pruned.
 */
export function planRetention(
  buf: Buffer,
  ttlCutoff: number,
  perCgByteCap: number,
): { kept: FrameRange[]; bytesPruned: number } {
  // First pass: locate TTL cut point + total post-TTL size.
  const survivors: FrameRange[] = [];
  let offset = 0;
  while (offset + ENTRY_HEADER_BYTES <= buf.length) {
    const timestampMs = Number(buf.readBigUInt64BE(offset));
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + ENTRY_HEADER_BYTES + len;
    if (end > buf.length) break;
    if (timestampMs >= ttlCutoff) {
      survivors.push({ start: offset, end });
    }
    offset = end;
  }
  let survivorBytes = survivors.reduce((sum, s) => sum + (s.end - s.start), 0);
  let dropIndex = 0;
  while (survivorBytes > perCgByteCap && dropIndex < survivors.length) {
    survivorBytes -= survivors[dropIndex].end - survivors[dropIndex].start;
    dropIndex += 1;
  }
  const kept = survivors.slice(dropIndex);
  const bytesPruned = buf.length - survivorBytes;
  return { kept, bytesPruned };
}

/** The bytes of the given frames, in order, as one buffer (the body of a pruned log). */
export function concatFrames(buf: Buffer, frames: readonly FrameRange[]): Buffer {
  const parts: Buffer[] = [];
  for (const s of frames) parts.push(Buffer.from(buf.subarray(s.start, s.end)));
  return Buffer.concat(parts);
}
