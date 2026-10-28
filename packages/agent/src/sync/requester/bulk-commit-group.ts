// SPDX-License-Identifier: Apache-2.0
import { BULK_GROUP_ASSETS, BULK_GROUP_EXPANDED_BYTES, BULK_GROUP_HEAP_BYTES } from '../bulk-graph-contract.js';
import { estimateQuadHeapBytes } from '../memory-telemetry.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';
export interface BulkVerifiedMember {
  readonly asset: VerifiedGraphScopedAsset;
  readonly index: number;
  readonly encodedBytes: number;
  readonly plainBytes: number;
}

/** Parsed assets stay bounded independently of the encoded staging window. */
export class BulkCommitGroup {
  private members: BulkVerifiedMember[] = [];
  private heap = 0;
  private expanded = 0;
  private startedAt = 0;
  constructor(private readonly publish: (members: readonly BulkVerifiedMember[]) => Promise<void>) {}
  get flushAt(): number | undefined { return this.members.length ? this.startedAt + 1000 : undefined; }

  async append(member: BulkVerifiedMember) {
    const { asset, plainBytes } = member;
    let heap = 0;
    for (const q of asset.dataQuads) heap += estimateQuadHeapBytes(q);
    for (const q of asset.metadataQuads) heap += estimateQuadHeapBytes(q);
    if (this.members.length && (this.heap + heap > BULK_GROUP_HEAP_BYTES
      || this.expanded + plainBytes > BULK_GROUP_EXPANDED_BYTES)) await this.flush();
    if (!this.members.length) this.startedAt = Date.now();
    this.members.push(member); this.heap += heap; this.expanded += plainBytes;
    await this.flushIfDue();
  }
  private async flushIfDue() {
    if (this.members.length >= BULK_GROUP_ASSETS || this.expanded >= BULK_GROUP_EXPANDED_BYTES
      || (this.flushAt !== undefined && Date.now() >= this.flushAt)) await this.flush();
  }
  async flush() {
    if (!this.members.length) return;
    await this.publish(this.members);
    this.members = []; this.heap = 0; this.expanded = 0;
  }
}
