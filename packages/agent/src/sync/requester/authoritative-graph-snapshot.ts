// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncCheckpointStore } from '../checkpoint/state.js';
import { deleteSyncPageCheckpoint, type SyncPageResult } from './page-fetch.js';

interface RetainedAuthoritativeSnapshot {
  readonly responderSessionId: string;
  expiresAtMs: number;
  nextOffset: number;
  rawNextOffset: number;
  readonly quads: Quad[];
  byteSize: number;
}

export interface AuthoritativeSnapshotRetentionLimits {
  readonly maxQuadsPerCheckpoint: number;
  readonly maxBytesPerCheckpoint: number;
  readonly maxQuadsTotal: number;
  readonly maxBytesTotal: number;
}

export const DEFAULT_AUTHORITATIVE_SNAPSHOT_RETENTION_LIMITS:
AuthoritativeSnapshotRetentionLimits = Object.freeze({
  maxQuadsPerCheckpoint: 250_000,
  maxBytesPerCheckpoint: 128 * 1024 * 1024,
  maxQuadsTotal: 500_000,
  maxBytesTotal: 256 * 1024 * 1024,
});

export interface AuthoritativeSnapshotPage {
  readonly checkpointKey: string;
  readonly resumedFromOffset: number;
  readonly rawResumedFromOffset?: number;
  readonly nextOffset: number;
  readonly rawNextOffset?: number;
  readonly completed: boolean;
  readonly timedOut: boolean;
}

export type AuthoritativeSnapshotCheckpointTransition =
  | { readonly kind: 'advance' }
  | { readonly kind: 'discard' }
  | {
      readonly kind: 'restore';
      readonly nextOffset: number;
      readonly rawNextOffset: number;
    };

export interface AuthoritativeSnapshotMaterializationRequest {
  readonly page: AuthoritativeSnapshotPage;
  readonly verifiedQuads: readonly Quad[];
  /** False when verification or phase semantics forbid retaining this prefix. */
  readonly retainablePrefix: boolean;
  /** True only when the requester proved the response reaches snapshot EOF. */
  readonly completeSnapshot: boolean;
  readonly commit: (completeSnapshot: readonly Quad[]) => Promise<number>;
  /** Synchronous requester checkpoint transition paired with retained state. */
  readonly transitionCheckpoint: (
    transition: AuthoritativeSnapshotCheckpointTransition,
  ) => void;
}

export type AuthoritativeSnapshotMaterializationResult =
  | {
      readonly kind: 'retained';
      readonly retainedTriples: number;
      readonly committedTriples: 0;
    }
  | {
      readonly kind: 'discarded';
      readonly retainedTriples: 0;
      readonly committedTriples: 0;
    }
  | {
      readonly kind: 'committed-snapshot';
      readonly retainedTriples: 0;
      readonly committedTriples: number;
    };

/**
 * Retains one authoritative graph snapshot outside the live graph until the
 * immutable responder session reaches EOF. The paired verified offset and raw
 * responder coordinate must match on every retry; a missing, expired, or
 * superseded session discards both the staging buffer and checkpoint.
 */
export class AuthoritativeGraphSnapshotMaterializer {
  private readonly retainedByCheckpoint = new Map<
    string,
    RetainedAuthoritativeSnapshot
  >();
  private readonly retentionLimits: AuthoritativeSnapshotRetentionLimits;
  private retainedQuadCount = 0;
  private retainedByteSize = 0;

  constructor(
    private readonly checkpointStore: SyncCheckpointStore,
    retentionLimits: Partial<AuthoritativeSnapshotRetentionLimits> = {},
  ) {
    this.retentionLimits = normalizeRetentionLimits(retentionLimits);
  }

  /**
   * Reconcile retained bytes with the durable requester checkpoint before a
   * new DATA fetch. A checkpoint without its private prefix cannot safely
   * resume, while a prefix without the exact responder session is stale.
   */
  prepareFetch(checkpointKey: string): void {
    const retained = this.retainedByCheckpoint.get(checkpointKey);
    const checkpoint = this.checkpointStore.get(checkpointKey);
    if (
      !retained
      && (
        !checkpoint
        || (
          checkpoint.offset === 0
          && (checkpoint.responderSessionOffset ?? 0) === 0
        )
      )
    ) return;
    if (
      retained
      && checkpoint
      && checkpoint.responderSessionId === retained.responderSessionId
      && checkpoint.offset === retained.nextOffset
      && (checkpoint.responderSessionOffset ?? checkpoint.offset) === retained.rawNextOffset
    ) return;
    this.discard(checkpointKey);
  }

  async materialize(
    request: AuthoritativeSnapshotMaterializationRequest,
  ): Promise<AuthoritativeSnapshotMaterializationResult> {
    const {
      page,
      verifiedQuads,
      retainablePrefix,
      completeSnapshot,
      commit,
      transitionCheckpoint,
    } = request;
    const checkpoint = this.checkpointStore.get(page.checkpointKey);
    const responderSessionId = checkpoint?.responderSessionId;
    const rawResumedFromOffset = page.rawResumedFromOffset ?? page.resumedFromOffset;
    const rawNextOffset = page.rawNextOffset ?? page.nextOffset;

    if (!retainablePrefix) {
      this.discard(page.checkpointKey);
      transitionCheckpoint({ kind: 'discard' });
      return { kind: 'discarded', committedTriples: 0, retainedTriples: 0 };
    }

    let retained: RetainedAuthoritativeSnapshot | undefined;
    if (page.resumedFromOffset === 0 && rawResumedFromOffset === 0) {
      // A new zero-offset response supersedes any private prefix for the same
      // key, while preserving the current responder checkpoint established by
      // the fetch that just completed.
      this.removeRetained(page.checkpointKey);
    } else {
      retained = this.retainedByCheckpoint.get(page.checkpointKey);
      if (
        !retained
        || responderSessionId === undefined
        || retained.responderSessionId !== responderSessionId
        || retained.nextOffset !== page.resumedFromOffset
        || retained.rawNextOffset !== rawResumedFromOffset
      ) {
        this.discard(page.checkpointKey);
        transitionCheckpoint({ kind: 'discard' });
        throw Object.assign(
          new Error('Authoritative snapshot continuation does not match its retained responder session'),
          { code: 'AUTHORITATIVE_SNAPSHOT_CONTINUATION_MISMATCH' },
        );
      }
    }

    const addedByteSize = retainedQuadByteSize(verifiedQuads);
    const candidateQuadCount = (retained?.quads.length ?? 0) + verifiedQuads.length;
    const candidateByteSize = (retained?.byteSize ?? 0) + addedByteSize;
    const candidateGlobalQuadCount = this.retainedQuadCount + verifiedQuads.length;
    const candidateGlobalByteSize = this.retainedByteSize + addedByteSize;
    if (!this.withinRetentionLimits(candidateQuadCount, candidateByteSize, verifiedQuads.length, addedByteSize)) {
      this.discard(page.checkpointKey);
      transitionCheckpoint({ kind: 'discard' });
      throw Object.assign(
        new Error(
          `Authoritative snapshot retention limit exceeded for ${page.checkpointKey} `
          + `(checkpoint=${candidateQuadCount} quads/${candidateByteSize} bytes, `
          + `global=${candidateGlobalQuadCount} quads/${candidateGlobalByteSize} bytes)`,
        ),
        { code: 'AUTHORITATIVE_SNAPSHOT_RETENTION_LIMIT' },
      );
    }

    const candidate = retained?.quads ?? [...verifiedQuads];
    const previousLength = candidate.length;
    if (retained) {
      // Extend the one retained array in place. This avoids copying the entire
      // verified prefix on every bounded continuation.
      for (const quad of verifiedQuads) candidate.push(quad);
    }

    if (completeSnapshot && page.completed && !page.timedOut) {
      let committedTriples: number;
      try {
        committedTriples = await commit(candidate);
      } catch (error) {
        // A failed final commit leaves the prior retained prefix paired with
        // its prior requester coordinate for a safe retry.
        if (retained) {
          candidate.length = previousLength;
          try {
            transitionCheckpoint({
              kind: 'restore',
              nextOffset: retained.nextOffset,
              rawNextOffset: retained.rawNextOffset,
            });
          } catch (restoreError) {
            this.discard(page.checkpointKey);
            throw new AggregateError(
              [error, restoreError],
              'Authoritative snapshot commit and requester-checkpoint restoration failed',
            );
          }
        }
        throw error;
      }
      // The final suffix was only a transient extension: retained usage still
      // accounts for the prior prefix, which is the state being removed.
      if (retained) candidate.length = previousLength;
      this.removeRetained(page.checkpointKey);
      transitionCheckpoint({ kind: 'advance' });
      return {
        kind: 'committed-snapshot',
        committedTriples,
        retainedTriples: 0,
      };
    }

    if (page.completed || responderSessionId === undefined || !checkpoint) {
      // A completed-but-uninstallable result will have its checkpoint deleted
      // by the requester. A store that cannot retain responder identity is
      // likewise unable to prove a later suffix belongs to this prefix.
      this.discard(page.checkpointKey);
      transitionCheckpoint({ kind: 'discard' });
      return { kind: 'discarded', committedTriples: 0, retainedTriples: 0 };
    }

    const expiresAtMs = Math.min(
      checkpoint.expiresAtMs,
      checkpoint.responderSessionExpiresAtMs ?? checkpoint.expiresAtMs,
    );
    if (retained) {
      retained.expiresAtMs = expiresAtMs;
      retained.nextOffset = page.nextOffset;
      retained.rawNextOffset = rawNextOffset;
      retained.byteSize = candidateByteSize;
    } else {
      retained = {
        responderSessionId,
        expiresAtMs,
        nextOffset: page.nextOffset,
        rawNextOffset,
        quads: candidate,
        byteSize: candidateByteSize,
      };
      this.retainedByCheckpoint.set(page.checkpointKey, retained);
    }
    this.retainedQuadCount += verifiedQuads.length;
    this.retainedByteSize += addedByteSize;
    try {
      transitionCheckpoint({ kind: 'advance' });
    } catch (error) {
      this.discard(page.checkpointKey);
      throw error;
    }
    return {
      kind: 'retained',
      committedTriples: 0,
      retainedTriples: candidate.length,
    };
  }

  discard(checkpointKey: string): void {
    this.removeRetained(checkpointKey);
    deleteSyncPageCheckpoint(this.checkpointStore, checkpointKey);
  }

  retainedTriples(checkpointKey: string): number {
    return this.retainedByCheckpoint.get(checkpointKey)?.quads.length ?? 0;
  }

  retainedUsage(): { readonly checkpoints: number; readonly quads: number; readonly bytes: number } {
    return {
      checkpoints: this.retainedByCheckpoint.size,
      quads: this.retainedQuadCount,
      bytes: this.retainedByteSize,
    };
  }

  pruneExpired(nowMs = Date.now()): number {
    let pruned = 0;
    for (const [checkpointKey, retained] of this.retainedByCheckpoint) {
      if (retained.expiresAtMs >= nowMs) continue;
      this.discard(checkpointKey);
      pruned += 1;
    }
    return pruned;
  }

  private withinRetentionLimits(
    checkpointQuads: number,
    checkpointBytes: number,
    addedQuads: number,
    addedBytes: number,
  ): boolean {
    return checkpointQuads <= this.retentionLimits.maxQuadsPerCheckpoint
      && checkpointBytes <= this.retentionLimits.maxBytesPerCheckpoint
      && this.retainedQuadCount + addedQuads <= this.retentionLimits.maxQuadsTotal
      && this.retainedByteSize + addedBytes <= this.retentionLimits.maxBytesTotal;
  }

  private removeRetained(checkpointKey: string): void {
    const retained = this.retainedByCheckpoint.get(checkpointKey);
    if (!retained) return;
    this.retainedByCheckpoint.delete(checkpointKey);
    this.retainedQuadCount -= retained.quads.length;
    this.retainedByteSize -= retained.byteSize;
  }
}

function normalizeRetentionLimits(
  limits: Partial<AuthoritativeSnapshotRetentionLimits>,
): AuthoritativeSnapshotRetentionLimits {
  const normalized = {
    ...DEFAULT_AUTHORITATIVE_SNAPSHOT_RETENTION_LIMITS,
    ...limits,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Authoritative snapshot retention limit ${name} must be a positive safe integer`);
    }
  }
  return normalized;
}

function retainedQuadByteSize(quads: readonly Quad[]): number {
  let bytes = 0;
  for (const quad of quads) {
    bytes += Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8')
      + Buffer.byteLength(quad.graph ?? '', 'utf8')
      + 4;
  }
  return bytes;
}

export function authoritativeSnapshotPage(result: SyncPageResult): AuthoritativeSnapshotPage {
  return {
    checkpointKey: result.checkpointKey,
    resumedFromOffset: result.resumedFromOffset,
    rawResumedFromOffset: result.rawResumedFromOffset,
    nextOffset: result.nextOffset,
    rawNextOffset: result.rawNextOffset,
    completed: result.completed,
    timedOut: result.timedOut,
  };
}
