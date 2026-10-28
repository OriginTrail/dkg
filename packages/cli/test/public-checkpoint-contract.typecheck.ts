import type { PublicCheckpointJob, RunningPublicCheckpointJob } from '../src/public-checkpoint-contract.js';
import { createPublicCheckpointClient } from '../src/public-checkpoint-client.js';

declare const status: PublicCheckpointJob;
if (status.state === 'complete') {
  const committed: 0 = status.result.committed;
  const current: false = status.result.current;
  const changed: false = status.result.activeStoreChanged;
  const state: 'verified-unpublished' = status.result.state;
  void [committed, current, changed, state];
}
if (status.state === 'complete') {
  const result: object = status.result;
  const identity: string = status.id;
  void [result, identity];
}
if (status.state === 'failed') { const error: string = status.error; void error; }
// @ts-expect-error A running job requires its identity and start time.
const unidentified: PublicCheckpointJob = { state: 'running' };
// @ts-expect-error A completed job requires its result.
const incomplete: PublicCheckpointJob = { state: 'complete', id: 'job', startedAt: 1 };
// @ts-expect-error A failed job requires an error.
const unexplained: PublicCheckpointJob = { state: 'failed', id: 'job', startedAt: 1 };
declare const client: ReturnType<typeof createPublicCheckpointClient>;
const running: Promise<RunningPublicCheckpointJob> = client.prepare({ contextGraphId: 'graph', onChainId: '1', trustedCorePeerIds: ['core'] });
void [unidentified, incomplete, unexplained, running];
