// SPDX-License-Identifier: Apache-2.0

/**
 * The settled walk owns its own parameter contract: a new caller supplies the
 * ports it actually consumes, and does NOT have to carry `setCheckpoint` from
 * the deprecated throwing helper. Legacy parameter objects stay assignable.
 */
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  settlePublicSnapshotsForMeta,
  syncPublicSnapshotsForMeta,
  type PublicSnapshotSettleParams,
} from '../src/sync/requester/shared-memory-sync.js';

declare const ctx: OperationContext;
declare const fetchSyncPages: PublicSnapshotSettleParams['fetchSyncPages'];

const settledOnly = {
  ctx,
  remotePeerId: 'peer',
  contextGraphId: 'cg',
  deadline: 1,
  metaQuads: [],
  fetchSyncPages,
  deleteCheckpoint: (_key: string) => {},
} satisfies PublicSnapshotSettleParams;

// No `setCheckpoint`: the settled API does not consume it.
void settlePublicSnapshotsForMeta(settledOnly);

// @ts-expect-error the deprecated throwing helper still requires its compatibility port.
void syncPublicSnapshotsForMeta(settledOnly);

// A legacy parameter object remains structurally assignable to the settled API.
const legacy = { ...settledOnly, setCheckpoint: (_key: string, _offset: number) => {} };
void syncPublicSnapshotsForMeta(legacy);
void settlePublicSnapshotsForMeta(legacy);
