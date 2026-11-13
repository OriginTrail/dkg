// SPDX-License-Identifier: Apache-2.0

import { normalizeContextGraphAuthorityHash as normalizeHash } from
  './context-graph-authority-generation.js';
import {
  type ContextGraphAuthorityIndexScopedRepository,
  type ContextGraphAuthorityIndexRepositoryRecord,
} from './context-graph-authority-index-repository.js';
import { ContextGraphAuthorityIndexRetryableError } from
  './context-graph-authority-index-errors.js';

const MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_LOST_INVALIDATIONS = 3;

/**
 * How far a durable cursor may sit ABOVE this endpoint's anchor and still be
 * explained by ordinary head skew.
 *
 * Anchored at the operator's depth rather than at the endpoint's `finalized`
 * tag, the anchor is the HEAD by default, and public RPC pools disagree about
 * the head by tens of blocks routinely. A cursor a little above this endpoint's
 * anchor therefore means "ask a different endpoint" — retryable, and the caller
 * fails over. A cursor FAR above one cannot be skew: it is a cursor recorded on
 * a chain view that no longer exists (a deep reorg, or a restored/copied store).
 * Retrying that forever wedges every authority read for the Context Graph and
 * fences exactly the catalog traffic this anchoring change exists to admit, so
 * past this distance the checkpoint is rebuilt instead. Matches
 * `CG_REGISTRY_REORG_BUFFER_BLOCKS`, the depth the Context Graph registry scan
 * already treats as reorg-safe.
 */
const MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_CURSOR_SKEW_BLOCKS = 50;

export interface ContextGraphAuthorityIndexAdmissionInput {
  readonly repository: ContextGraphAuthorityIndexScopedRepository;
  readonly initial: ContextGraphAuthorityIndexRepositoryRecord;
  readonly deploymentBlockNumber: number;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly lifecycleSignal: AbortSignal;
  /** Evict remotely servable observations as soon as a durable row is rejected. */
  readonly onRejectedCheckpoint?: () => void;
  /**
   * Whether this index committed this exact record, or admitted it against a
   * chain view, within the last few minutes of its current lifecycle.
   *
   * Such a cursor was on a live chain view moments ago, so a scan anchored
   * below it, however far, has an anchor that is out of date: it waited behind
   * another scan, or its endpoint lags. That is a retry against a newer anchor,
   * never evidence for a rebuild. Only a record this index has not proven yet
   * (a restored or copied store, or a chain reset between runs) may still be
   * rebuilt for being out of reach.
   */
  readonly provenLocally?: (record: ContextGraphAuthorityIndexRepositoryRecord) => boolean;
  readonly readBlockHash: (
    blockNumber: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<string | null>;
}

/**
 * Admit one durable observation through a direct, bounded recovery loop.
 *
 * Missing rows and tombstones rebuild immediately. Every rejected token gets
 * one conditional invalidation; when another writer wins, its row is reloaded
 * by the repository and classified here. Three lost invalidations therefore
 * permit three winner reloads, but a fourth invalidation is never attempted.
 */
export async function admitContextGraphAuthorityIndexCheckpoint(
  input: Readonly<ContextGraphAuthorityIndexAdmissionInput>,
): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
  let record = input.initial;
  let lostInvalidations = 0;

  for (;;) {
    input.lifecycleSignal.throwIfAborted();
    if (record.kind === 'missing' || record.kind === 'tombstone') return record;

    if (record.kind === 'checkpoint') {
      const checkpoint = record.checkpoint;
      if (checkpoint.cursor.deploymentBlockNumber === input.deploymentBlockNumber) {
        const cursorSkew = checkpoint.cursor.throughBlockNumber - input.finalized.number;
        if (
          cursorSkew > MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_CURSOR_SKEW_BLOCKS
          && input.provenLocally?.(record) !== true
        ) {
          // Unreachable by skew: fall through to invalidation and rebuild
          // rather than retrying a cursor no endpoint will ever catch up to.
          // The cursor only ever moves FORWARD (`commitOrReloadWinner` has no
          // lowering path), so without this the wedge is permanent.
          //
          // Not for a record this index proved itself (see `provenLocally`).
          // Throwing that one away costs a walk from the deployment block,
          // which on a long history outlasts every reader that waits for it,
          // and a scan that outlasts its readers is exactly the one whose
          // anchor falls this far behind the next scan's commit.
        } else if (cursorSkew > 0) {
          throw new ContextGraphAuthorityIndexRetryableError(
            `Context Graph authority index finalized head ${input.finalized.number} is behind `
            + `durable cursor ${checkpoint.cursor.throughBlockNumber}`,
            'cursor-ahead',
          );
        } else {
          const anchorHash = checkpoint.cursor.throughBlockNumber === input.finalized.number
            ? input.finalized.hash
            : normalizeHash(await input.readBlockHash(
                checkpoint.cursor.throughBlockNumber,
                input.lifecycleSignal,
              ));
          input.lifecycleSignal.throwIfAborted();
          if (anchorHash === undefined) {
            throw new ContextGraphAuthorityIndexRetryableError(
              `Context Graph authority index anchor ${checkpoint.cursor.throughBlockNumber} `
              + 'is unavailable',
            );
          }
          if (anchorHash === checkpoint.cursor.throughBlockHash) return record;
        }
      }
    }

    input.onRejectedCheckpoint?.();
    if (lostInvalidations >= MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_LOST_INVALIDATIONS) {
      throw new ContextGraphAuthorityIndexRetryableError(
        'Context Graph authority index changed repeatedly during checkpoint recovery',
      );
    }
    const recovery = await input.repository.invalidateOrReloadWinner(record, input.lifecycleSignal);
    if (recovery.kind === 'invalidated') return recovery.record;
    lostInvalidations += 1;
    record = recovery.record;
  }
}
