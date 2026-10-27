// daemon/routes/list-page-fault.ts
//
// OT-RFC-73 P9b: what the paged mode of the two job list routes does with a fault in the stored job rows (a row that cannot
// be read or placed in the page order). It is the node's fault, not the request's, so it stays a 500 for the daemon's one error
// mapping, but two things are fixed here. The mapping writes no log line, so a sign of store corruption would leave nothing in the
// node log: this logs one warn line. And it writes the thrown error's message into the body, which for an unreadable publisher
// row names the job subject: the error is rethrown with a fixed message and the queue's own error kept as `cause`. Neither the
// line nor the message carries a job subject or id.

/** The routes this module reports for, as the warn line names them. */
export type PagedListRoute = 'GET /api/knowledge-assets/swm/share-jobs' | 'GET /api/publisher/jobs';

/** Log one warn line, then throw the error the daemon answers with a `500`. */
export function failPageFault(route: PagedListRoute, kind: string, cause: unknown): never {
  console.warn(`[list-paging] ${route}: a stored job row could not be read or placed in the page order (${kind}); answering 500`);
  throw new Error('The job list cannot be paged: a stored job row is unreadable or out of order (see the node log)', { cause });
}
