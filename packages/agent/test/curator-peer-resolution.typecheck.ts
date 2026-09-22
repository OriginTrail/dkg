import type { CuratorPeerIdsResolution } from '../src/index.js';

const bounded: CuratorPeerIdsResolution = {
  peerIds: ['peer-a'],
  curatorIsLocal: false,
  legacyTripleResolved: false,
  rosterStatus: 'continue',
  overflowed: true,
  nextPageAfterPeerId: 'peer-a',
};

const contradictory: CuratorPeerIdsResolution = {
  peerIds: ['peer-a'],
  curatorIsLocal: false,
  legacyTripleResolved: false,
  rosterStatus: 'continue',
  overflowed: true,
  nextPageAfterPeerId: 'peer-a',
  // @ts-expect-error A resolved roster has no second independently valid peer list.
  rosterTraversal: { status: 'continue', peerIds: ['peer-b'], nextAfterPeerId: 'peer-b' },
};

void bounded;
void contradictory;
