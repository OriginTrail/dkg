/**
 * Chunked-digest stream chain (port of the fork's `seller/streaming.ts`),
 * kept as a pure utility for the deferred end-to-end streaming phase; it has
 * no consumer yet (the gateway serves buffered SSE).
 *
 *   chain_0   = sha256(utf8 "dkg-mkt:stream:v1")
 *   chain_i   = sha256(chain_{i-1} ‖ frame_i)          (i ≥ 1, raw bytes)
 *   root      = chain_N                               (N = frame count)
 *   bytesDigest = sha256(concat(frames))              (the classic commitment)
 *
 * A tampered, dropped or reordered frame changes the root.
 */
import { createHash } from 'node:crypto';

export const STREAM_CHAIN_SCHEME = 'dkg-mkt:stream:v1' as const;

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

export interface StreamChainAccumulator {
  push(frame: Uint8Array): void;
  /** `sha256:<hex>` of the current chain head. */
  root(): string;
  frameCount(): number;
  /** `sha256:<hex>` over the concatenated frames. */
  bytesDigest(): string;
  bytes(): Uint8Array;
}

export function streamChainAccumulator(): StreamChainAccumulator {
  let chain = sha256(Buffer.from(STREAM_CHAIN_SCHEME, 'utf8'));
  const frames: Uint8Array[] = [];
  return {
    push(frame: Uint8Array): void {
      chain = sha256(chain, frame);
      frames.push(Uint8Array.from(frame));
    },
    root: () => `sha256:${chain.toString('hex')}`,
    frameCount: () => frames.length,
    bytesDigest: () => `sha256:${sha256(...frames).toString('hex')}`,
    bytes: () => Buffer.concat(frames),
  };
}

export interface StreamChainClaim {
  streamChainRoot: string;
  frameCount: number;
  bytesDigest: string;
}

/** Buyer-side incremental verifier: feed frames as they arrive, then `finalize` against the claim. */
export function streamChainVerifier(): {
  push(frame: Uint8Array): void;
  finalize(claim: StreamChainClaim): { ok: true; bytes: Uint8Array } | { ok: false; detail: string };
} {
  const acc = streamChainAccumulator();
  return {
    push: (frame) => acc.push(frame),
    finalize(claim) {
      if (acc.frameCount() !== claim.frameCount) {
        return { ok: false, detail: `frameCount ${acc.frameCount()} ≠ claimed ${claim.frameCount}` };
      }
      if (acc.root() !== claim.streamChainRoot) {
        return { ok: false, detail: `stream chain root mismatch after ${acc.frameCount()} frames` };
      }
      if (acc.bytesDigest() !== claim.bytesDigest) {
        return { ok: false, detail: 'reassembled bytes do not match the claimed bytes digest' };
      }
      return { ok: true, bytes: acc.bytes() };
    },
  };
}
