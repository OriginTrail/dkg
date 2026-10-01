// SPDX-License-Identifier: Apache-2.0
import { requireExactAssetUals } from './exact-assets.js';
import { decodeNegotiatedExactSyncResponse, EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES } from './wire-compression.js';

import {
  EXACT_BATCH_FRAME_KIND, EXACT_BATCH_MAX_ASSETS,
  validateExactBatchFrame, type ExactBatchFrame, type ExactBatchRefusal,
} from '@origintrail-official/dkg-core';
export {
  EXACT_BATCH_STREAM_PROTOCOL, EXACT_BATCH_STREAM_WINDOW_SIZE, EXACT_BATCH_FRAME_KIND,
  EXACT_BATCH_BATCH_INDEX, EXACT_BATCH_FRAME_HEADER_BYTES, EXACT_BATCH_MAX_FRAME_BYTES,
  EXACT_BATCH_MAX_REQUEST_BYTES, EXACT_BATCH_MAX_ASSETS, EXACT_BATCH_MAX_CHUNKS_PER_ASSET,
  EXACT_BATCH_REFUSALS, encodeExactBatchFrame, decodeExactBatchFrames, validateExactBatchFrame,
  type ExactBatchFrame, type ExactBatchFrameKind, type ExactBatchRefusal,
} from '@origintrail-official/dkg-core';
const EMPTY = new Uint8Array(0);

export interface ReceivedExactBatchAsset {
  readonly assetIndex: number;
  readonly assetUal: string;
  readonly metadataBytes: Uint8Array;
  /** One unchanged negotiated exact-sync response, not the whole batch. */
  readonly dataBytes: Uint8Array;
  readonly chunkCount: number;
}
interface Slot {
  metadata: Uint8Array; chunks: Uint8Array[]; bytes: number; chunkCount: number;
  ended: boolean; delivered?: ReceivedExactBatchAsset;
}

/**
 * Asset ownership only. The supplied callback must retain normal canonical
 * chain/CG/version/root/count checks and atomic materialization. META is proof
 * input and cannot grant authority. At most one decoded/committing KA exists;
 * window two permits only the next bounded compressed KA to overlap it.
 */
export class ExactBatchReceiveWindow {
  readonly assetUals: readonly string[];
  readonly windowSize: 1 | 2;
  private slots = new Map<number, Slot>();
  private started = 0;
  private receiving: number | undefined;
  private ended = false;
  private closed = false;
  private activeCommit: Promise<ExactBatchFrame> | undefined;
  private committed = 0;
  private refusalCode: ExactBatchRefusal | undefined;

  constructor(options: { readonly assetUals: readonly string[]; readonly windowSize?: 1 | 2 }) {
    const canonical = requireExactAssetUals(options.assetUals);
    if (canonical.length !== options.assetUals.length) throw new Error('Exact batch assets must be distinct');
    this.assetUals = Object.freeze(canonical);
    this.windowSize = options.windowSize ?? 1;
    if (this.windowSize !== 1 && this.windowSize !== 2) throw new Error('Invalid exact batch receive window');
  }
  get committedCount(): number { return this.committed; }
  get startedCount(): number { return this.started; }
  get atAssetBoundary(): boolean { return this.receiving === undefined; }
  get complete(): boolean { return !this.closed && this.ended && this.committed === this.assetUals.length; }
  get refusal(): ExactBatchRefusal | undefined { return this.refusalCode; }
  get retainedWireBytes(): number { let total = 0; for (const slot of this.slots.values()) total += slot.bytes + slot.metadata.byteLength; return total; }
  get retainedAssets(): number { return this.slots.size; }

  accept(frame: ExactBatchFrame): void {
    if (this.closed || this.ended || this.refusalCode) throw new Error('Exact batch receive window is closed');
    validateExactBatchFrame(frame);
    const k = EXACT_BATCH_FRAME_KIND;
    if (frame.kind === k.REFUSE) { this.refusalCode = new TextDecoder().decode(frame.payload) as ExactBatchRefusal; return; }
    if (frame.kind === k.BATCH_END) {
      if (this.receiving !== undefined || this.started !== this.assetUals.length || frame.sequence !== this.assetUals.length) throw new Error('Premature exact batch end');
      this.ended = true; return;
    }
    if (frame.kind === k.META) {
      if (this.receiving !== undefined || frame.assetIndex !== this.started || this.started >= this.assetUals.length || this.slots.size >= this.windowSize) throw new Error('Exact batch order or window exceeded');
      this.slots.set(frame.assetIndex, { metadata: frame.payload.slice(), chunks: [], bytes: 0, chunkCount: 0, ended: false });
      this.receiving = frame.assetIndex; this.started++; return;
    }
    const slot = this.slots.get(frame.assetIndex);
    if (!slot || this.receiving !== frame.assetIndex || slot.ended || frame.sequence !== slot.chunkCount) throw new Error('Invalid exact batch data order');
    if (frame.kind === k.DATA) {
      if (slot.bytes + frame.payload.byteLength > EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) throw new RangeError('Exact batch asset exceeds physical wire allowance');
      slot.chunks.push(frame.payload.slice()); slot.bytes += frame.payload.byteLength; slot.chunkCount++; return;
    }
    if (frame.kind !== k.ASSET_END || slot.bytes === 0) throw new Error('Invalid exact batch asset end');
    slot.ended = true; this.receiving = undefined;
  }

  takeReady(): ReceivedExactBatchAsset | undefined {
    if (this.closed || this.refusalCode) return undefined;
    const slot = this.slots.get(this.committed);
    if (!slot?.ended || slot.delivered || this.activeCommit) return undefined;
    const dataBytes = new Uint8Array(slot.bytes); let offset = 0;
    for (const chunk of slot.chunks) { dataBytes.set(chunk, offset); offset += chunk.byteLength; }
    slot.chunks = []; // no whole-batch concatenation or duplicate retained chunk list
    slot.delivered = Object.freeze({ assetIndex: this.committed, assetUal: this.assetUals[this.committed]!,
      metadataBytes: slot.metadata, dataBytes, chunkCount: slot.chunkCount });
    return slot.delivered;
  }

  commitAsset(asset: ReceivedExactBatchAsset, verifyAndAtomicCommit: (asset: ReceivedExactBatchAsset, signal?: AbortSignal) => Promise<void>, options: { readonly signal?: AbortSignal } = {}): Promise<ExactBatchFrame> {
    options.signal?.throwIfAborted();
    const slot = this.slots.get(this.committed);
    if (this.closed || this.refusalCode || this.activeCommit || !slot || slot.delivered !== asset || asset.assetIndex !== this.committed) throw new Error('Unowned or unordered exact batch commit');
    const operation = (async (): Promise<ExactBatchFrame> => {
      await verifyAndAtomicCommit(asset, options.signal);
      // Record physical success even if cancellation arrived during the write.
      this.committed++; this.slots.delete(asset.assetIndex);
      options.signal?.throwIfAborted();
      if (this.closed || this.refusalCode) throw new Error('Exact batch closed during physical commit');
      return Object.freeze({ kind: EXACT_BATCH_FRAME_KIND.ACK, assetIndex: asset.assetIndex, sequence: asset.chunkCount, payload: EMPTY });
    })();
    this.activeCommit = operation;
    void operation.then(() => { this.activeCommit = undefined; }, () => { this.closed = true; this.activeCommit = undefined; this.slots.clear(); this.receiving = undefined; });
    return operation;
  }

  /** Do not release ownership while the actual verifier/write is still running. */
  async close(): Promise<void> {
    this.closed = true;
    try { await this.activeCommit; } catch { /* caller receives the original commit error */ }
    this.slots.clear(); this.receiving = undefined;
  }
}

/** Sender credit follows successful receiver commit, never mere receipt. */
export class ExactBatchSendWindow {
  readonly assetCount: number;
  readonly windowSize: 1 | 2;
  private started = 0;
  private receiving: number | undefined;
  private outstanding = new Map<number, { bytes: number; chunks: number; ended: boolean }>();
  private acknowledged = 0;
  private ended = false;
  private closed = false;
  constructor(options: { readonly assetCount: number; readonly windowSize?: 1 | 2 }) {
    if (!Number.isInteger(options.assetCount) || options.assetCount < 1 || options.assetCount > EXACT_BATCH_MAX_ASSETS) throw new Error('Invalid exact batch asset count');
    this.assetCount = options.assetCount; this.windowSize = options.windowSize ?? 1;
    if (this.windowSize !== 1 && this.windowSize !== 2) throw new Error('Invalid exact batch send window');
  }
  get canStartAsset(): boolean { return !this.closed && !this.ended && this.receiving === undefined && this.started < this.assetCount && this.outstanding.size < this.windowSize; }
  get acknowledgedCount(): number { return this.acknowledged; }
  get complete(): boolean { return !this.closed && this.ended && this.acknowledged === this.assetCount; }
  /** Validate/reserve before send. Any send failure must close this session. */
  acceptSent(frame: ExactBatchFrame): void {
    if (this.closed || this.ended) throw new Error('Exact batch send window is closed');
    validateExactBatchFrame(frame);
    const k = EXACT_BATCH_FRAME_KIND;
    if (frame.kind === k.REFUSE) { this.closed = true; return; }
    if (frame.kind === k.BATCH_END) {
      if (this.receiving !== undefined || this.started !== this.assetCount || frame.sequence !== this.assetCount) throw new Error('Premature exact batch send end');
      this.ended = true; return;
    }
    if (frame.kind === k.META) {
      if (!this.canStartAsset || frame.assetIndex !== this.started) throw new Error('Exact batch send order or window exceeded');
      this.outstanding.set(frame.assetIndex, { bytes: 0, chunks: 0, ended: false }); this.receiving = frame.assetIndex; this.started++; return;
    }
    const slot = this.outstanding.get(frame.assetIndex);
    if (!slot || this.receiving !== frame.assetIndex || slot.ended || frame.sequence !== slot.chunks) throw new Error('Invalid exact batch send data order');
    if (frame.kind === k.DATA) {
      if (slot.bytes + frame.payload.byteLength > EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) throw new RangeError('Exact batch asset exceeds physical wire allowance');
      slot.bytes += frame.payload.byteLength; slot.chunks++; return;
    }
    if (frame.kind !== k.ASSET_END || slot.bytes === 0) throw new Error('Invalid exact batch send asset end');
    slot.ended = true; this.receiving = undefined;
  }
  acceptAck(frame: ExactBatchFrame): void {
    if (this.closed) throw new Error('Exact batch send window is closed');
    validateExactBatchFrame(frame);
    const slot = this.outstanding.get(this.acknowledged);
    if (frame.kind !== EXACT_BATCH_FRAME_KIND.ACK || frame.assetIndex !== this.acknowledged || !slot?.ended || frame.sequence !== slot.chunks) throw new Error('Invalid exact batch commit ACK');
    this.outstanding.delete(this.acknowledged); this.acknowledged++;
  }
  close(): void { this.closed = true; this.outstanding.clear(); this.receiving = undefined; }
}

/** Unsupported/resource/missing is eligible for fresh legacy work after close. */
export function isRecoverableExactBatchRefusal(code: ExactBatchRefusal | undefined): boolean {
  return code === 'UNSUPPORTED' || code === 'RESOURCE_LIMIT' || code === 'ASSET_MISSING';
}

export function decodeExactBatchAsset(asset: ReceivedExactBatchAsset, options: { readonly signal?: AbortSignal } = {}) {
  return decodeNegotiatedExactSyncResponse(asset.dataBytes, { allowCompression: true, signal: options.signal });
}
