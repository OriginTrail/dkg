// SPDX-License-Identifier: Apache-2.0

import { normalizeContextGraphAuthorityHash as normalizeHash } from
  './context-graph-authority-generation.js';
import {
  ContextGraphAuthorityIndexRepository,
  type ContextGraphAuthorityIndexRepositoryRecord,
} from './context-graph-authority-index-repository.js';

const MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_LOST_INVALIDATIONS = 3;

export class ContextGraphAuthorityIndexRetryableError extends Error {
  override readonly name = 'ContextGraphAuthorityIndexRetryableError';
}

export function isContextGraphAuthorityIndexRetryableError(
  error: unknown,
): error is ContextGraphAuthorityIndexRetryableError {
  return error instanceof ContextGraphAuthorityIndexRetryableError;
}

function retryableAuthorityIndexReadError(message: string): Error {
  return new ContextGraphAuthorityIndexRetryableError(message);
}

export interface ContextGraphAuthorityIndexAdmissionInput {
  readonly repository: ContextGraphAuthorityIndexRepository;
  readonly scope: string;
  readonly initial: ContextGraphAuthorityIndexRepositoryRecord;
  readonly deploymentBlockNumber: number;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly lifecycleSignal: AbortSignal;
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
        if (checkpoint.cursor.throughBlockNumber > input.finalized.number) {
          throw retryableAuthorityIndexReadError(
            `Context Graph authority index finalized head ${input.finalized.number} is behind `
            + `durable cursor ${checkpoint.cursor.throughBlockNumber}`,
          );
        }
        const anchorHash = checkpoint.cursor.throughBlockNumber === input.finalized.number
          ? input.finalized.hash
          : normalizeHash(await input.readBlockHash(
              checkpoint.cursor.throughBlockNumber,
              input.lifecycleSignal,
            ));
        if (anchorHash === undefined) {
          throw retryableAuthorityIndexReadError(
            `Context Graph authority index anchor ${checkpoint.cursor.throughBlockNumber} `
            + 'is unavailable',
          );
        }
        if (anchorHash === checkpoint.cursor.throughBlockHash) return record;
      }
    }

    if (lostInvalidations >= MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_LOST_INVALIDATIONS) {
      throw retryableAuthorityIndexReadError(
        'Context Graph authority index changed repeatedly during checkpoint recovery',
      );
    }
    const recovery = await input.repository.invalidateOrReloadWinner(input.scope, record);
    if (recovery.kind === 'invalidated') return recovery.record;
    lostInvalidations += 1;
    record = recovery.record;
  }
}
