import { createStrictFinalizedEndpointRunnerV1, type StrictFinalizedEndpointRunnerProfileV1 } from '../dist/strict-current-finalized-evm-lifecycle.js';
import type { StrictFinalizedEndpointSessionV1, StrictRpcConfigSnapshotV1 } from '../dist/strict-current-finalized-evm-types.js';

const one: StrictFinalizedEndpointSessionV1 = ['https://one.example'];
const two: StrictFinalizedEndpointSessionV1 = ['https://one.example', 'https://two.example'];
// @ts-expect-error A finalized session cannot exceed the two-attempt ceiling.
const three: StrictFinalizedEndpointSessionV1 = ['https://one.example', 'https://two.example', 'https://three.example'];
// @ts-expect-error A validated configuration cannot hold an unbounded endpoint array.
const unbounded: StrictRpcConfigSnapshotV1['endpoints'] = [] as string[];
void [one, two, three, unbounded];

// The actual attempt owner must retain the validated cardinality boundary.
declare const runnerOptions: Omit<StrictFinalizedEndpointRunnerProfileV1, 'endpoints'>;
createStrictFinalizedEndpointRunnerV1({ ...runnerOptions, endpoints: one });
createStrictFinalizedEndpointRunnerV1({ ...runnerOptions, endpoints: two });
// @ts-expect-error The attempt-owning runner cannot receive a three-endpoint session.
createStrictFinalizedEndpointRunnerV1({ ...runnerOptions, endpoints: ['https://one.example', 'https://two.example', 'https://three.example'] });
// @ts-expect-error The attempt-owning runner cannot receive an unvalidated endpoint array.
createStrictFinalizedEndpointRunnerV1({ ...runnerOptions, endpoints: [] as string[] });
