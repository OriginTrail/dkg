import type { LiftRequest } from '@origintrail-official/dkg-publisher';
import type { AssetPartitionQuad } from '@origintrail-official/dkg-core';

export interface SharedMemoryWriteResult {
  shareOperationId: string;
}

export interface SharedMemoryWriteClient {
  share(contextGraphId: string, quads: AssetPartitionQuad[], options?: { subGraphName?: string }): Promise<SharedMemoryWriteResult>;
}

export interface AsyncLiftJobClient {
  lift(request: LiftRequest): Promise<string>;
  getJobStatus(jobId: string): Promise<string>;
}

export function createDaemonSharedMemoryWriteClient(daemonUrl: string, token: string): SharedMemoryWriteClient {
  return {
    async share(contextGraphId: string, quads: AssetPartitionQuad[], options: { subGraphName?: string } = {}): Promise<SharedMemoryWriteResult> {
      const response = await fetch(`${daemonUrl}/api/shared-memory/write`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contextGraphId,
          quads,
          subGraphName: options.subGraphName,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      return { shareOperationId: (payload as { shareOperationId?: string }).shareOperationId ?? '' };
    },
  };
}

export function createDaemonAsyncLiftJobClient(daemonUrl: string, token: string): AsyncLiftJobClient {
  return {
    async lift(request: LiftRequest): Promise<string> {
      const response = await fetch(`${daemonUrl}/api/publisher/enqueue`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      const jobId = (payload as { jobId?: string }).jobId;
      if (!jobId) throw new Error('Async publisher enqueue did not return a job id');
      return jobId;
    },
    async getJobStatus(jobId: string): Promise<string> {
      const response = await fetch(`${daemonUrl}/api/publisher/job?id=${encodeURIComponent(jobId)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      return (payload as { job?: { status?: string } }).job?.status ?? 'unknown';
    },
  };
}
