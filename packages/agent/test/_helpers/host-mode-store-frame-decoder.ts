// SPDX-License-Identifier: Apache-2.0

// Deliberately independent of the production codec: it cannot vouch for itself.
export const HEADER_BYTES = 20;
export interface DecodedHostStoreFrame { timestampMs: number; seqno: number; payload: Buffer }
export function decodeHostStoreFrames(buf: Buffer): { frames: DecodedHostStoreFrame[]; validLength: number } {
  const frames: DecodedHostStoreFrame[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= buf.length) {
    const end = offset + HEADER_BYTES + buf.readUInt32BE(offset + 16);
    if (end > buf.length) break;
    frames.push({ timestampMs: Number(buf.readBigUInt64BE(offset)), seqno: Number(buf.readBigUInt64BE(offset + 8)),
      payload: Buffer.from(buf.subarray(offset + HEADER_BYTES, end)) });
    offset = end;
  }
  return { frames, validLength: offset };
}
