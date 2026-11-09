/**
 * OT-RFC-73 P9b: the campaign scripts read a job list one page at a time instead of asking the daemon for the whole history in one
 * request (`pageSize`, `cursor`: see docs/references/api.md, "Listing async jobs").
 *
 * `complete` on a page means no further row when THAT page was read. A walk that reached it holds every job that was listed for the
 * whole walk, once, and nothing more: a job admitted behind the cursor is not part of it. So a job that is missing from a walk is
 * never evidence that it does not exist (or was lost); callers keep polling, and only a job they SAW counts. Evidence about absence
 * has to come from somewhere else (the store, the journal), never from `complete`.
 */

/** The daemon's largest page, so a long list takes the fewest requests. */
export const JOB_PAGE_SIZE = 1000;

/**
 * Every job of a list route, as the response of the complete route: `{ status: 200, value: { jobs } }` plus the first page's
 * request fields, so the evidence files keep the shape the verifiers read.
 *
 * `get(route)` resolves `{ status, value, ... }`, the value being the parsed body. A page that is not a `200` with a `jobs` array
 * ends the walk and is returned as it came, so the caller sees the failure exactly as a single read would show it. A first answer
 * with neither `complete` nor `nextCursor` is the complete list of a daemon that predates paging (it ignored the parameters) and is
 * returned as it came. Any other answer that cannot be continued (an incomplete page with no new cursor) throws: continuing could
 * repeat or skip jobs, and a truncated list must never be taken for a complete one.
 */
export async function getAllJobPages(get, route, pageSize = JOB_PAGE_SIZE) {
  const jobs = [];
  let first;
  let cursor;
  for (;;) {
    const params = new URLSearchParams({ pageSize: String(pageSize), ...(cursor === undefined ? {} : { cursor }) });
    const page = await get(`${route}${route.includes('?') ? '&' : '?'}${params}`);
    first ??= page;
    const body = page.value;
    if (page.status !== 200 || !Array.isArray(body?.jobs)) return page;
    if (cursor === undefined && body.complete === undefined && body.nextCursor === undefined) return page;
    jobs.push(...body.jobs);
    if (body.complete === true) return { ...first, value: { jobs } };
    if (body.complete !== false || typeof body.nextCursor !== 'string' || body.nextCursor === '' || body.nextCursor === cursor) {
      throw new Error(`${route}: an incomplete page without a new cursor after ${jobs.length} jobs; the list is not complete`);
    }
    cursor = body.nextCursor;
  }
}
