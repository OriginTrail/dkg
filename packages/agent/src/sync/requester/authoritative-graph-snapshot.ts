// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncCheckpointStore } from '../checkpoint/state.js';
import { deleteSyncPageCheckpoint, type SyncPageResult } from './page-fetch.js';

interface RetainedAuthoritativeSnapshot {
  readonly responderSessionId: string;
  readonly expiresAtMs: number;
  readonly nextOffset: number;
  readonly rawNextOffset: number;
  readonly quads: readonly Quad[];
}

export interface AuthoritativeSnapshotPage {
  readonly checkpointKey: string;
  readonly resumedFromOffset: number;
  readonly rawResumedFromOffset?: number;
  readonly nextOffset: number;
  readonly rawNextOffset?: number;
  readonly completed: boolean;
  readonly timedOut: boolean;
}

export interface AuthoritativeSnapshotMaterializationRequest {
  readonly page: AuthoritativeSnapshotPage;
  readonly verifiedQuads: readonly Quad[];
  /** False when verification or phase semantics forbid retaining this prefix. */
  readonly retainablePrefix: boolean;
  /** True only when the requester proved the response reaches snapshot EOF. */
  readonly completeSnapshot: boolean;
  readonly commit: (completeSnapshot: readonly Quad[]) => Promise<number>;
}

export interface AuthoritativeSnapshotMaterializationResult {
  /** Rows made visible by this call; staged rows deliberately report zero. */
  readonly committedTriples: number;
  readonly retainedTriples: number;
  readonly committed: boolean;
}

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

  constructor(private readonly checkpointStore: SyncCheckpointStore) {}

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
    const { page, verifiedQuads, retainablePrefix, completeSnapshot, commit } = request;
    const checkpoint = this.checkpointStore.get(page.checkpointKey);
    const responderSessionId = checkpoint?.responderSessionId;
    const rawResumedFromOffset = page.rawResumedFromOffset ?? page.resumedFromOffset;
    const rawNextOffset = page.rawNextOffset ?? page.nextOffset;

    if (!retainablePrefix) {
      this.discard(page.checkpointKey);
      return { committedTriples: 0, retainedTriples: 0, committed: false };
    }

    let retainedQuads: readonly Quad[];
    if (page.resumedFromOffset === 0 && rawResumedFromOffset === 0) {
      retainedQuads = [...verifiedQuads];
    } else {
      const retained = this.retainedByCheckpoint.get(page.checkpointKey);
      if (
        !retained
        || responderSessionId === undefined
        || retained.responderSessionId !== responderSessionId
        || retained.nextOffset !== page.resumedFromOffset
        || retained.rawNextOffset !== rawResumedFromOffset
      ) {
        this.discard(page.checkpointKey);
        throw Object.assign(
          new Error('Authoritative snapshot continuation does not match its retained responder session'),
          { code: 'AUTHORITATIVE_SNAPSHOT_CONTINUATION_MISMATCH' },
        );
      }
      retainedQuads = [...retained.quads, ...verifiedQuads];
    }

    if (completeSnapshot && page.completed && !page.timedOut) {
      const committedTriples = await commit(retainedQuads);
      this.retainedByCheckpoint.delete(page.checkpointKey);
      return {
        committedTriples,
        retainedTriples: 0,
        committed: true,
      };
    }

    if (page.completed || responderSessionId === undefined || !checkpoint) {
      // A completed-but-uninstallable result will have its checkpoint deleted
      // by the requester. A store that cannot retain responder identity is
      // likewise unable to prove a later suffix belongs to this prefix.
      this.discard(page.checkpointKey);
      return { committedTriples: 0, retainedTriples: 0, committed: false };
    }

    this.retainedByCheckpoint.set(page.checkpointKey, {
      responderSessionId,
      expiresAtMs: Math.min(
        checkpoint.expiresAtMs,
        checkpoint.responderSessionExpiresAtMs ?? checkpoint.expiresAtMs,
      ),
      nextOffset: page.nextOffset,
      rawNextOffset,
      quads: retainedQuads,
    });
    return {
      committedTriples: 0,
      retainedTriples: retainedQuads.length,
      committed: false,
    };
  }

  discard(checkpointKey: string): void {
    this.retainedByCheckpoint.delete(checkpointKey);
    deleteSyncPageCheckpoint(this.checkpointStore, checkpointKey);
  }

  retainedTriples(checkpointKey: string): number {
    return this.retainedByCheckpoint.get(checkpointKey)?.quads.length ?? 0;
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
