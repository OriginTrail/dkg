import {
  createSelectedSwmMetaRetentionBudget,
  type SelectedSwmMetaRetentionLimits,
  type SelectedSwmMetaRetentionLease,
  type SelectedSwmMetaRetentionReservation,
} from '@origintrail-official/dkg-agent/dist/sync/selected-swm-meta-budget.js';
import {
  createSelectedSwmMetaFetcher,
  SelectedSwmMetaTransferOwner,
  type SelectedSwmMetaFetcher,
  type SelectedSwmMetaContinuation,
} from '@origintrail-official/dkg-agent/dist/sync/selected-swm-meta-fetcher.js';
import { SelectedSwmMetaTransferCoordinator } from '@origintrail-official/dkg-agent/dist/sync/selected-swm-meta-transfer-coordinator.js';
import type { SwmMetaFetcher, SwmMetaTransferOwner } from '@origintrail-official/dkg-agent/dist/sync/swm-meta-fetcher.js';
import type { SwmMetaTransferCoordinator } from '@origintrail-official/dkg-agent/dist/sync/swm-meta-transfer-coordinator.js';
import type { SelectedSwmMetaRetentionScope, SwmMetaRetentionScope } from '@origintrail-official/dkg-agent/dist/sync/checkpoint/state.js';

const limits: SelectedSwmMetaRetentionLimits = {
  maxRows: 1, maxPrefixRows: 1, maxBytesEstimate: 1024, maxPrefixBytesEstimate: 1024,
};
const budget = createSelectedSwmMetaRetentionBudget(limits);
const lease: SelectedSwmMetaRetentionLease = budget.lease();
const reservation: SelectedSwmMetaRetentionReservation = lease.reserve();
reservation.release();
lease.release();
const owner: SwmMetaTransferOwner = new SelectedSwmMetaTransferOwner();
const coordinator: SwmMetaTransferCoordinator = new SelectedSwmMetaTransferCoordinator();
const selectedScope: SelectedSwmMetaRetentionScope = 'selected-swm-meta:retained:compatibility';
const generalizedScope: SwmMetaRetentionScope = selectedScope;
// @ts-expect-error The old selected scope type still excludes ordinary owners.
const invalidSelectedScope: SelectedSwmMetaRetentionScope = 'ordinary-swm-meta:retained:compatibility';
const legacyFetcher: SelectedSwmMetaFetcher = createSelectedSwmMetaFetcher({
  remotePeerId: 'peer', requesterScope: selectedScope, retentionBudget: budget,
  deleteCheckpoint: () => {},
  fetchPage: async request => {
    // Existing callbacks may rely on the selected-only request scope.
    const scope: SelectedSwmMetaRetentionScope = request.requesterScope;
    void scope;
    return {
      quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 0,
      checkpointKey: 'compatibility', completed: true, timedOut: false,
    };
  },
});
const currentFetcher: SwmMetaFetcher = legacyFetcher;
const continuation: SelectedSwmMetaContinuation = legacyFetcher.continuation('cg');
void owner;
void coordinator;
void generalizedScope;
void invalidSelectedScope;
void currentFetcher;
void continuation;

coordinator.run({ mode: 'selected', remotePeerId: 'peer' }, () => currentFetcher, async () => {});
new SelectedSwmMetaTransferCoordinator().run('peer', () => legacyFetcher, async () => {});
// @ts-expect-error The canonical coordinator requires an explicit mode and peer.
coordinator.run('peer', () => currentFetcher, async () => {});
// @ts-expect-error Encoded registry keys are not part of the canonical API.
coordinator.run('ordinary\0peer', () => currentFetcher, async () => {});
