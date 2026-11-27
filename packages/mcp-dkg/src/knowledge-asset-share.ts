/**
 * What the daemon answers to a Knowledge Asset share
 * (`POST /api/knowledge-assets/:name/swm/share`), and the share tool's reply
 * for a share that completed.
 */

/** A committed share whose catalog handoff its recovery job still owes. */
export interface PendingCatalogHandoff {
  readonly state: 'pending';
  readonly reason: string;
  readonly recoveryJobId: string;
  /** The daemon path that reports the recovery job. */
  readonly recoveryStatusUrl?: string;
}

export interface KnowledgeAssetShareResult {
  swmShared: boolean;
  promotedCount: number;
  sealed: boolean;
  publishReady: boolean;
  shareOperationId?: string;
  /** Present while the share's catalog handoff is still pending. */
  catalogHandoff?: PendingCatalogHandoff;
}

/**
 * The share tool's reply for a complete share. A share whose catalog handoff
 * is still pending says so, with the recovery job that completes it and how to
 * follow that job, as `dkg ka share` prints it.
 */
export function describeCompletedShare(
  name: string,
  projectId: string,
  result: Pick<KnowledgeAssetShareResult, 'catalogHandoff'>,
): string {
  const shared = `Shared complete knowledge asset '${name}' (project '${projectId}') to SWM (sealed:true, publish-ready).`;
  const handoff = result.catalogHandoff;
  if (handoff?.state !== 'pending') return shared;
  const follow = `dkg ka share-job ${handoff.recoveryJobId}`
    + (handoff.recoveryStatusUrl ? ` or GET ${handoff.recoveryStatusUrl}` : '');
  return `${shared} Its catalog handoff is still pending (${handoff.reason}): `
    + `recovery job ${handoff.recoveryJobId} completes it. Follow it with ${follow}.`;
}
