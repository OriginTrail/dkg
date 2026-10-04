// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ContextGraphAuthorityIndexHorizonCoordinator } from
  '../src/context-graph-authority-index-horizon.js';
import type {
  ContextGraphAuthorityIndexAdmittedRepositoryRecord,
  ContextGraphAuthorityIndexCommittedRepositoryRecord,
} from '../src/context-graph-authority-index-repository.js';
import { reduceContextGraphAuthorityIndexPage } from
  '../src/context-graph-authority-index-reducer.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const ZERO_HASH = `0x${'00'.repeat(32)}`;

/** Direct coordinator tests intentionally bypass the repository's private observation brand. */
const admittedMissing = (): ContextGraphAuthorityIndexAdmittedRepositoryRecord => (
  Object.freeze({ kind: 'missing' as const, token: undefined }) as unknown as
    ContextGraphAuthorityIndexAdmittedRepositoryRecord
);
const admittedTombstone = (
  token: number,
): ContextGraphAuthorityIndexAdmittedRepositoryRecord => (
  Object.freeze({ kind: 'tombstone' as const, token }) as unknown as
    ContextGraphAuthorityIndexAdmittedRepositoryRecord
);
const committedCheckpoint = (
  token: number,
): ContextGraphAuthorityIndexCommittedRepositoryRecord => (
  Object.freeze({
    kind: 'checkpoint' as const,
    token,
    checkpoint: reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 0,
      throughBlockNumber: 0,
      throughBlockHash: ZERO_HASH,
      events: [],
    }).checkpoint,
  }) as unknown as ContextGraphAuthorityIndexCommittedRepositoryRecord
);

const horizonCoordinator = (): ContextGraphAuthorityIndexHorizonCoordinator => (
  new ContextGraphAuthorityIndexHorizonCoordinator({
    onConstraintChanged: () => undefined,
    onProjectionInvalidated: () => undefined,
  })
);

describe('Context Graph authority index horizon coordinator', () => {
  it('does not trust a pre-rejection tombstone descendant until it is re-admitted', async () => {
    const horizons = horizonCoordinator();
    const repositoryKey = `${SCOPE}:durable`;
    const oldHash = `0x${(29).toString(16).padStart(64, '0')}`;
    const newHash = `0x${(1_000_029).toString(16).padStart(64, '0')}`;

    // This physical scan started from tombstone token 2 and committed a first
    // page at token 3 before any rejection existed.
    const preRejection = horizons.begin(SCOPE, { number: 29, hash: oldHash });
    preRejection.admitDurableGeneration(repositoryKey, admittedTombstone(2));
    preRejection.commitDurableGeneration(repositoryKey, committedCheckpoint(3));

    // A competing provider rejects checkpoint token 3 and begins its
    // conditional invalidation. The old physical scan then wins that CAS by
    // committing token 4, but has not re-admitted token 4 after the rejection.
    const rejecting = horizons.begin(SCOPE, { number: 29, hash: newHash });
    rejecting.activate();
    rejecting.markCheckpointRejected(repositoryKey, 3);
    preRejection.commitDurableGeneration(repositoryKey, committedCheckpoint(4));

    preRejection.commit();
    await expect(Promise.resolve().then(() => {
      horizons.assertAtOrAbove(SCOPE, { number: 29, hash: oldHash });
    })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });

    // The rejecting scan force-rejects that descendant too, then rebuilds only
    // after its token-4 invalidation establishes tombstone token 5.
    rejecting.markCheckpointRejected(repositoryKey, 4);
    rejecting.admitDurableGeneration(repositoryKey, admittedTombstone(5));
    rejecting.commitDurableGeneration(repositoryKey, committedCheckpoint(6));
    rejecting.commit();
    expect(() => horizons.assertAtOrAbove(
      SCOPE,
      { number: 29, hash: newHash },
    )).not.toThrow();
  });

  it('does not let a multi-page root lineage advance past a later rejection', () => {
    const horizons = horizonCoordinator();
    const repositoryKey = `${SCOPE}:durable`;
    const oldHash = `0x${(29).toString(16).padStart(64, '0')}`;
    const newHash = `0x${(1_000_029).toString(16).padStart(64, '0')}`;
    const older = horizons.begin(SCOPE, { number: 29, hash: oldHash });
    older.admitDurableGeneration(repositoryKey, admittedTombstone(2));
    older.commitDurableGeneration(repositoryKey, committedCheckpoint(3));

    const rejecting = horizons.begin(SCOPE, { number: 29, hash: newHash });
    rejecting.activate();
    rejecting.admitDurableGeneration(repositoryKey, committedCheckpoint(3));
    older.commitDurableGeneration(repositoryKey, committedCheckpoint(4));
    rejecting.markCheckpointRejected(repositoryKey, 3);
    older.commitDurableGeneration(repositoryKey, committedCheckpoint(5));

    older.commit();
    rejecting.rollback();
    expect(() => horizons.assertAtOrAbove(
      SCOPE,
      { number: 29, hash: oldHash },
    )).toThrow('behind durable refresh horizon');
  });

  it('does not let a pre-rejection root on another repository clear the fence', () => {
    const horizons = horizonCoordinator();
    const oldHash = `0x${(29).toString(16).padStart(64, '0')}`;
    const newHash = `0x${(1_000_029).toString(16).padStart(64, '0')}`;
    const fallback = horizons.begin(SCOPE, { number: 29, hash: oldHash });
    fallback.admitDurableGeneration(`${SCOPE}:plain`, admittedMissing());

    const rejecting = horizons.begin(SCOPE, { number: 29, hash: newHash });
    rejecting.activate();
    rejecting.markCheckpointRejected(`${SCOPE}:trusted`, 3);
    fallback.commitDurableGeneration(`${SCOPE}:plain`, committedCheckpoint(1));

    fallback.commit();
    rejecting.rollback();
    expect(() => horizons.assertAtOrAbove(
      SCOPE,
      { number: 29, hash: oldHash },
    )).toThrow('behind durable refresh horizon');
  });
});
