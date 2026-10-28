// SPDX-License-Identifier: Apache-2.0
import type { PublicSnapshotSyncOptions } from '@origintrail-official/dkg-agent';

import type { PublicCheckpointJob, RunningPublicCheckpointJob } from './public-checkpoint-contract.js';
export type { PublicCheckpointJob } from './public-checkpoint-contract.js';

type CheckpointRequest<T> = T extends unknown ? Omit<T, 'signal' | 'transport'> & { native?: boolean } : never;
export type PublicCheckpointRequest = CheckpointRequest<PublicSnapshotSyncOptions>;

export function createPublicCheckpointClient(http: {
  get<T>(path: string, options: { auth: true }): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}) {
  const path = '/api/context-graph/snapshot-checkpoint';
  return {
    status: () => http.get<PublicCheckpointJob>(path, { auth: true }),
    prepare: (request: PublicCheckpointRequest) => http.post<RunningPublicCheckpointJob>(path, request),
  };
}
