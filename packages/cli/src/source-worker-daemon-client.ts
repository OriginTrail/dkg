import type { AssetPartitionQuad } from '@origintrail-official/dkg-core';
import type { SourceWorkerJobFailureDetails, SourceWorkerJobStatusResult } from '@origintrail-official/dkg-agent';
import type { KnowledgeAssetContentEnvelope } from './api-client.js';

export interface KnowledgeAssetLifecyclePublishAsyncResponse extends KnowledgeAssetContentEnvelope {
  jobId: string;
  shareOperationId?: string;
  intentKey?: string;
}

export interface KnowledgeAssetLifecycleClient {
  createAndShare(
    contextGraphId: string,
    name: string,
    quads: AssetPartitionQuad[],
    options?: { subGraphName?: string },
  ): Promise<{ promotedCount: number; publishReady?: boolean; shareOperationId?: string }>;
  publishAsync(
    contextGraphId: string,
    name: string,
    options?: { subGraphName?: string },
  ): Promise<KnowledgeAssetLifecyclePublishAsyncResponse>;
  getJobStatus(jobId: string): Promise<SourceWorkerJobStatusResult>;
}

export function createDaemonKnowledgeAssetLifecycleClient(
  daemonUrl: string,
  token: string,
): KnowledgeAssetLifecycleClient {
  return {
    async createAndShare(
      contextGraphId: string,
      name: string,
      quads: AssetPartitionQuad[],
      options: { subGraphName?: string } = {},
    ): Promise<{ promotedCount: number; publishReady?: boolean; shareOperationId?: string }> {
      const response = await fetch(`${daemonUrl}/api/knowledge-assets`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          contextGraphId,
          name,
          quads,
          finalize: true,
          alsoShareSwm: true,
          subGraphName: options.subGraphName,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      const errors = Array.isArray((payload as { errors?: unknown }).errors)
        ? (payload as { errors: unknown[] }).errors
        : [];
      if (errors.length > 0) {
        throw new Error(`Knowledge asset create/share returned partial lifecycle errors: ${JSON.stringify(errors)}`);
      }
      const promotedCount = numberField((payload as { promotedCount?: unknown }).promotedCount) ?? 0;
      const publishReady = booleanField((payload as { publishReady?: unknown }).publishReady);
      const shareOperationId = stringField((payload as { shareOperationId?: unknown }).shareOperationId);
      const swmShared = booleanField((payload as { swmShared?: unknown }).swmShared);
      if (swmShared !== true || publishReady !== true || promotedCount <= 0 || !shareOperationId) {
        throw new Error(
          `Knowledge asset create/share did not produce a publish-ready SWM share ` +
            `(swmShared=${String(swmShared)}, publishReady=${String(publishReady)}, ` +
            `promotedCount=${promotedCount}, shareOperationId=${shareOperationId ?? 'missing'})`,
        );
      }
      return {
        promotedCount,
        publishReady,
        shareOperationId,
      };
    },

    async publishAsync(
      contextGraphId: string,
      name: string,
      options: { subGraphName?: string } = {},
    ): Promise<KnowledgeAssetLifecyclePublishAsyncResponse> {
      const response = await fetch(`${daemonUrl}/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish-async`, {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify({
          contextGraphId,
          subGraphName: options.subGraphName,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      const jobId = (payload as { jobId?: string }).jobId;
      if (!jobId) throw new Error('Knowledge asset async publish did not return a job id');
      return {
        jobId,
        shareOperationId: stringField((payload as { shareOperationId?: unknown }).shareOperationId),
        contentScopeVersion: numberField((payload as { contentScopeVersion?: unknown }).contentScopeVersion),
        kaUal: stringField((payload as { kaUal?: unknown }).kaUal),
        assertionVersion: stringField((payload as { assertionVersion?: unknown }).assertionVersion),
        publicTripleCount: numberField((payload as { publicTripleCount?: unknown }).publicTripleCount),
        privateMerkleRoot: stringField((payload as { privateMerkleRoot?: unknown }).privateMerkleRoot),
        privateTripleCount: numberField((payload as { privateTripleCount?: unknown }).privateTripleCount),
        intentKey: stringField((payload as { intentKey?: unknown }).intentKey),
      };
    },

    async getJobStatus(jobId: string): Promise<SourceWorkerJobStatusResult> {
      const response = await fetch(`${daemonUrl}/api/publisher/job?id=${encodeURIComponent(jobId)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      const job = ((payload as { job?: unknown }).job ?? payload) as Record<string, unknown>;
      return {
        status: stringField(job.status) ?? 'unknown',
        txHash: stringField(job.txHash) ?? stringField(recordField(job.result)?.txHash),
        ual: stringField(job.ual) ?? stringField(recordField(job.result)?.ual),
        failureDetails: normalizeFailureDetails(job.failureDetails ?? job.failure ?? job.error),
      };
    },
  };
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function normalizeFailureDetails(value: unknown): SourceWorkerJobFailureDetails | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return { message: value };
  }
  const record = recordField(value);
  if (!record) {
    return { details: value };
  }
  return {
    status: stringField(record.status),
    code: stringField(record.code),
    message: stringField(record.message) ?? stringField(record.error),
    details: record,
  };
}
