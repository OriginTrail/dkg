import type {
  Rfc64CatalogReplayRecoveryCommandV1,
} from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';

const pending: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'pending-recovery',
  contextGraphId: 'cg',
  policyDigest: 'digest',
};

const full: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'full-connected-peers',
  contextGraphId: 'cg',
  policyDigest: 'digest',
  connectedPeerIds: ['peer'],
};

const invalidPending: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'pending-recovery',
  contextGraphId: 'cg',
  policyDigest: 'digest',
  // @ts-expect-error Pending recovery cannot carry a peer-seeding instruction.
  connectedPeerIds: ['peer'],
};

const invalidConnection: Rfc64CatalogReplayRecoveryCommandV1 = {
  kind: 'connection-demand',
  contextGraphId: 'cg',
  policyDigest: 'digest',
  demand: { peerId: 'peer', generation: 1 },
  // @ts-expect-error A connection demand cannot also claim full-replay semantics.
  connectedPeerIds: ['peer'],
};

void pending;
void full;
void invalidPending;
void invalidConnection;
