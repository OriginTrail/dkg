import type { StrictFinalizedEndpointSessionV1, StrictRpcConfigSnapshotV1 } from '../dist/strict-current-finalized-evm-types.js';

const one: StrictFinalizedEndpointSessionV1 = ['https://one.example'];
const two: StrictFinalizedEndpointSessionV1 = ['https://one.example', 'https://two.example'];
// @ts-expect-error A finalized session cannot exceed the two-attempt ceiling.
const three: StrictFinalizedEndpointSessionV1 = ['https://one.example', 'https://two.example', 'https://three.example'];
// @ts-expect-error A validated configuration cannot hold an unbounded endpoint array.
const unbounded: StrictRpcConfigSnapshotV1['endpoints'] = [] as string[];
void [one, two, three, unbounded];
