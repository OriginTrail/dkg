// daemon/routes/list-paging-query.ts
//
// OT-RFC-73 P9b (decision D-8): the opt-in paging parameters of the two job list routes,
// `GET /api/knowledge-assets/swm/share-jobs` and `GET /api/publisher/jobs`.
//
// A list request with neither `cursor` nor `pageSize` is the complete listing it always was. Either one
// chooses the paged mode: `pageSize` alone asks for the first page, `cursor` (the previous page's
// `nextCursor`, unchanged) for the page after it, and a page is 100 jobs unless `pageSize` says otherwise.
// `limit` caps the complete listing and has no meaning in the paged mode, so it is refused there rather than
// guessed at. The queue validates the cursor and the page size itself and raises a typed error that the route
// maps to `400`; this module only reads the parameters and hands anything it cannot read on in a form the
// queue refuses: a repeated parameter becomes an empty cursor or a NaN page size, so there is one rule per
// queue and no second copy of it here.

import type { ServerResponse } from 'node:http';
import { jsonResponse } from '../http-utils.js';

export type ListPaging =
  | { readonly paged: false }
  | { readonly paged: true; readonly cursor: string | undefined; readonly pageSize: number | undefined };

/** `limit` was sent together with `cursor` or `pageSize`. */
export const LIST_PAGING_LIMIT_CONFLICT = 'LIST_PAGING_LIMIT_CONFLICT';

const CANONICAL_PAGE_SIZE = /^[1-9]\d*$/;

/** The paging mode of a list request, or `null` after answering `400` for a `limit` sent with a paging parameter. */
export function parseListPaging(url: URL, res: ServerResponse): ListPaging | null {
  const cursors = url.searchParams.getAll('cursor');
  const sizes = url.searchParams.getAll('pageSize');
  if (cursors.length === 0 && sizes.length === 0) return { paged: false };
  if (url.searchParams.has('limit')) {
    jsonResponse(res, 400, {
      error: 'limit applies to the complete listing only; use pageSize with cursor to page',
      code: LIST_PAGING_LIMIT_CONFLICT,
    });
    return null;
  }
  return {
    paged: true,
    cursor: cursors.length === 0 ? undefined : cursors.length === 1 ? cursors[0] : '',
    pageSize: sizes.length === 0 ? undefined : sizes.length === 1 && CANONICAL_PAGE_SIZE.test(sizes[0]!) ? Number(sizes[0]) : Number.NaN,
  };
}
