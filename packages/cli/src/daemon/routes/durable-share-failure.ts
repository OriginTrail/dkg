import type { AsyncPromoteQueue } from '@origintrail-official/dkg-publisher';

export type ShareRecoveryObservation =
  | Readonly<{ state: 'pending' | 'inspection-required' | 'admission-unconfirmed' | 'unobserved' | 'completed'; jobId: string }>
  | Readonly<{ state: 'unavailable' }>;

/** The original domain error and the observed owner state remain separate. */
export class DurableShareFailure extends Error {
  constructor(cause: unknown, readonly observation: ShareRecoveryObservation) {
    super(cause instanceof Error ? cause.message : 'Share completion could not be confirmed', { cause });
  }
}

/** One status URL for a share job, so success and failure answers name it the same way. */
export function shareJobStatusUrl(jobId: string): string {
  return `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(jobId)}`;
}

/** A conflict is not evidence that a worker will retry it. */
export async function observeShareRecovery(queue: AsyncPromoteQueue, jobId: string): Promise<ShareRecoveryObservation> {
  try {
    const job = await queue.getStatus(jobId);
    if (!job) return { state: 'unobserved', jobId };
    switch (job.state) {
      case 'queued': case 'running': case 'failed_retrying': return { state: 'pending', jobId };
      case 'failed': return { state: 'inspection-required', jobId };
      case 'succeeded': return { state: 'completed', jobId };
    }
  } catch { return { state: 'unobserved', jobId }; }
}
