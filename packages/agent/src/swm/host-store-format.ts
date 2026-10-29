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

/** One canonical frame walk: incomplete headers or payloads terminate the log. */
function* frames(buf: Buffer): Generator<FrameRange & { payloadStart: number; timestampMs: number; seqno: number }> {
  let start = 0;
  while (start + ENTRY_HEADER_BYTES <= buf.length) {
    const payloadStart = start + ENTRY_HEADER_BYTES;
    const end = payloadStart + buf.readUInt32BE(start + 16);
    if (end > buf.length) return;
    yield { start, end, payloadStart, timestampMs: Number(buf.readBigUInt64BE(start)),
      seqno: Number(buf.readBigUInt64BE(start + 8)) };
    start = end;
  }
}

/** Recover the highest cursor and the end of the last complete frame. */
export function scanLogFrames(buf: Buffer): { lastSeqno: number; validLength: number } {
  let lastSeqno = 0, validLength = 0;
  for (const frame of frames(buf)) {
    lastSeqno = Math.max(lastSeqno, frame.seqno);
    validLength = frame.end;
  }
  return { lastSeqno, validLength };
}

/**
 * The entries of a log with seqno strictly greater than `sinceSeqno`, in log
 * (seqno-ascending) order, at most `limit` of them when given.
 */
export function readEntriesSince(buf: Buffer, sinceSeqno: number, limit?: number): SwmHostModeEntry[] {
  const out: SwmHostModeEntry[] = [];
  for (const frame of frames(buf)) {
    if (frame.seqno > sinceSeqno) {
      out.push({ seqno: frame.seqno, timestampMs: frame.timestampMs,
        envelopeBytes: new Uint8Array(buf.subarray(frame.payloadStart, frame.end)) });
      if (limit !== undefined && out.length >= limit) break;
    }
  }
  return out;
}

/** The number of complete frames in a log buffer. */
export function countFrames(buf: Buffer): number {
  let entries = 0;
  for (const _frame of frames(buf)) entries += 1;
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
  for (const frame of frames(buf)) {
    if (frame.timestampMs >= ttlCutoff) survivors.push({ start: frame.start, end: frame.end });
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
