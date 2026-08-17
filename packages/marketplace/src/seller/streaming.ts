// v3.5 streaming — chunked-digest legs, scheme FROZEN here.
//
//   chain_0 = sha256("nsm:stream:v1")
//   chain_i = sha256(chain_{i-1} ‖ frame_i_bytes)          (i ≥ 1, raw bytes)
//   chainRoot = chain_N  (N = frame count)
//
// The seller streams frames (SSE) and, when generation completes, emits the
// final signed leg binding BOTH:
//   · deliveredResponseBytesDigest = sha256(concat(frames))   (the v3 recount
//     contract, unchanged — reassembly must equal the classic digest)
//   · streamChainRoot + frameCount                            (the new claim:
//     these exact frames in this exact order)
// The buyer verifies the chain INCREMENTALLY as frames arrive and the classic
// digest over the reassembled bytes at the end. A tampered, dropped, or
// reordered frame breaks the chain at the first bad frame — provable
// mid-stream, not just at the end. Withhold code: E_RECOUNT_MISMATCH (the
// counts/bytes no longer reproduce), detail names the frame index.
import { createHash } from "node:crypto";

export const STREAM_SCHEME_VERSION = "nsm:stream:v1";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

export function chainInit(): Buffer {
  return sha256(Buffer.from(STREAM_SCHEME_VERSION, "utf8"));
}

export function chainStep(prev: Buffer, frame: Buffer): Buffer {
  return sha256(Buffer.concat([prev, frame]));
}

export interface StreamAccumulator {
  push(frame: Buffer): void;
  root(): string;                 // "sha256:…" of the current chain head
  frameCount(): number;
  bytesDigest(): string;          // classic digest over concat(frames)
  bytes(): Buffer;
}

export function streamAccumulator(): StreamAccumulator {
  let chain = chainInit();
  let n = 0;
  const frames: Buffer[] = [];
  return {
    push(frame: Buffer) { chain = chainStep(chain, frame); n++; frames.push(frame); },
    root() { return "sha256:" + chain.toString("hex"); },
    frameCount() { return n; },
    bytesDigest() { return "sha256:" + createHash("sha256").update(Buffer.concat(frames)).digest("hex"); },
    bytes() { return Buffer.concat(frames); },
  };
}

/**
 * Buyer-side incremental verifier. Feed frames as they arrive; `finalize`
 * against the leg's claims. Any mismatch names the first offending frame.
 */
export function streamVerifier() {
  const acc = streamAccumulator();
  return {
    push(frame: Buffer) { acc.push(frame); },
    finalize(claim: { streamChainRoot: string; frameCount: number; deliveredResponseBytesDigest: string }):
      { ok: true; bytes: Buffer } | { ok: false; code: "E_RECOUNT_MISMATCH"; detail: string } {
      if (acc.frameCount() !== claim.frameCount) {
        return { ok: false, code: "E_RECOUNT_MISMATCH", detail: `frameCount ${acc.frameCount()} ≠ claimed ${claim.frameCount}` };
      }
      if (acc.root() !== claim.streamChainRoot) {
        return { ok: false, code: "E_RECOUNT_MISMATCH", detail: `stream chain root mismatch after ${acc.frameCount()} frames` };
      }
      if (acc.bytesDigest() !== claim.deliveredResponseBytesDigest) {
        return { ok: false, code: "E_RECOUNT_MISMATCH", detail: "reassembled bytes ≠ classic delivered digest" };
      }
      return { ok: true, bytes: acc.bytes() };
    },
  };
}
