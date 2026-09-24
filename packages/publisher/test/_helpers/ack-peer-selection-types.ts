import type { ACKCandidatePeerSelectionInput } from '../../src/ack-peer-selection.js';

const rankedOnly: ACKCandidatePeerSelectionInput = {
  connectedPeers: ['core', 'edge'],
  requiredACKs: 3,
};
const coreOnly: ACKCandidatePeerSelectionInput = {
  ...rankedOnly,
  capability: { mode: 'require', v1: new Set(['core']) },
};

// @ts-expect-error Requiring core capability also requires a V1 capability set.
const invalid: ACKCandidatePeerSelectionInput = { ...rankedOnly, capability: { mode: 'require' } };

void [rankedOnly, coreOnly, invalid];
