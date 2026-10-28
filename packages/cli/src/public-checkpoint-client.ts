// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent, PublicSnapshotSyncOptions } from '@origintrail-official/dkg-agent';

export interface PublicCheckpointJob {
  id?: string; state: 'idle' | 'running' | 'complete' | 'failed'; error?: string;
  result?: Awaited<ReturnType<DKGAgent['preparePublicGraphCheckpoint']>>;
}
export function createPublicCheckpointClient(http: {
  get<T>(path: string, options: { auth: true }): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}) {
  const path = '/api/context-graph/snapshot-checkpoint';
  return {
    status: () => http.get<PublicCheckpointJob>(path, { auth: true }),
    prepare: (request: Omit<PublicSnapshotSyncOptions, 'signal' | 'transport'> & { native?: boolean }) => http.post<PublicCheckpointJob>(path, request),
  };
}
