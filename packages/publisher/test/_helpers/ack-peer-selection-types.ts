import type { ACKCandidatePeerSelectionInput } from '../../src/ack-peer-selection.js';

const rankedOnly: ACKCandidatePeerSelectionInput = {
  connectedPeers: ['core', 'edge'],
  requiredACKs: 3,
};
const coreOnly: ACKCandidatePeerSelectionInput = {
  ...rankedOnly,
  eligiblePeerIds: new Set(['core']),
};

// @ts-expect-error Core filtering is represented only by an explicit eligible peer set.
const invalid: ACKCandidatePeerSelectionInput = { ...rankedOnly, requireConfirmedCore: true };

void [rankedOnly, coreOnly, invalid];
