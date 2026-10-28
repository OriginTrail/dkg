// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '@origintrail-official/dkg-agent';

export type PublicCheckpointJob = { state: 'idle' } | ({ id: string; startedAt: number } & (
  | { state: 'running' }
  | { state: 'complete'; result: Awaited<ReturnType<DKGAgent['preparePublicGraphCheckpoint']>> }
  | { state: 'failed'; error: string }
));
export type RunningPublicCheckpointJob = Extract<PublicCheckpointJob, { state: 'running' }>;
