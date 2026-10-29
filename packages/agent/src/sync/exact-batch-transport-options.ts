// SPDX-License-Identifier: Apache-2.0
import {
  EXACT_BATCH_FRAME_HEADER_BYTES, EXACT_BATCH_MAX_FRAME_BYTES, EXACT_BATCH_MAX_REQUEST_BYTES,
  EXACT_BATCH_MAX_ASSETS, EXACT_BATCH_MAX_CHUNKS_PER_ASSET, type ExactBatchTransportOptions,
} from '@origintrail-official/dkg-core';
import { EXACT_BATCH_STREAM_WINDOW_SIZE } from './exact-batch-stream-contract.js';
import { EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES } from './wire-compression.js';

/** Shared bounded transport limits for the exact batch requester and responder. */
export function exactBatchTransportOptions(timeoutMs: number, signal?: AbortSignal): ExactBatchTransportOptions {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new RangeError('Exact batch transport deadline outside bounded recovery profile');
  const maxFrameBytes = EXACT_BATCH_MAX_FRAME_BYTES + EXACT_BATCH_FRAME_HEADER_BYTES;
  return { timeoutMs, signal, maxRequestBytes: EXACT_BATCH_MAX_REQUEST_BYTES, maxFrameBytes, maxReadBufferBytes: 2 * maxFrameBytes,
    maxResponseBytes: EXACT_BATCH_MAX_ASSETS * (EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES + EXACT_BATCH_MAX_FRAME_BYTES
      + (EXACT_BATCH_MAX_CHUNKS_PER_ASSET + 2) * EXACT_BATCH_FRAME_HEADER_BYTES)
      + EXACT_BATCH_MAX_REQUEST_BYTES + EXACT_BATCH_FRAME_HEADER_BYTES,
    windowSize: EXACT_BATCH_STREAM_WINDOW_SIZE };
}
