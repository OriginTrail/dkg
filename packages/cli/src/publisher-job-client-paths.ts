/**
 * Paging options of the publisher job list (OT-RFC-73 P9b): `pageSize` alone asks for the first page, `cursor` (the previous
 * page's `nextCursor`) for the page after it. Without either the daemon answers the complete listing.
 */
export interface PublisherJobsPageOptions {
  cursor?: string;
  pageSize?: number;
}

/**
 * The list answer. `nextCursor` and `complete` are present exactly when the request paged: `complete` means no further job
 * when that page was read, never proof that none was accepted since.
 */
export interface PublisherJobsResult {
  jobs: any[];
  nextCursor?: string | null;
  complete?: boolean;
}

export function publisherJobsPath(status?: string, contextGraphId?: string, page?: PublisherJobsPageOptions): string {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (contextGraphId) qs.set('contextGraphId', contextGraphId);
  if (page?.cursor !== undefined) qs.set('cursor', page.cursor);
  if (page?.pageSize !== undefined) qs.set('pageSize', String(page.pageSize));
  return `/api/publisher/jobs${qs.size ? `?${qs}` : ''}`;
}
