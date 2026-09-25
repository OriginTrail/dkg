import type { ACKCandidatePeerSelectionInput } from '../../src/ack-peer-selection-compat.js';

const rankedOnly: ACKCandidatePeerSelectionInput = {
  connectedPeers: ['core', 'edge'],
  requiredACKs: 3,
};
const coreOnly: ACKCandidatePeerSelectionInput = {
  ...rankedOnly,
  capability: { mode: 'require', corePeers: new Set(['core']) },
};

// @ts-expect-error Requiring core capability also requires a core peer set.
const invalid: ACKCandidatePeerSelectionInput = { ...rankedOnly, capability: { mode: 'require' } };
// @ts-expect-error Nested V1/V2 aliases are no longer part of the capability API.
const nestedLegacy: ACKCandidatePeerSelectionInput = { ...rankedOnly, capability: { mode: 'require', v1: new Set(['core']) } };

void [rankedOnly, coreOnly, invalid, nestedLegacy];
