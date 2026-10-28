import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_PAGE_SIZE, getAllJobPages } from './job-pages.mjs';

/**
 * A fake paged daemon: jobs ordered by (t, id), opaque cursors naming the last row of the previous page. `rows` can change
 * between requests, as the real queues do.
 */
function daemon(rows) {
  const requests = [];
  const get = async (route) => {
    requests.push(route);
    const url = new URL(route, 'http://daemon');
    const size = Number(url.searchParams.get('pageSize'));
    const cursor = url.searchParams.get('cursor');
    const after = cursor === null ? null : JSON.parse(Buffer.from(cursor, 'base64url').toString());
    const sorted = [...rows].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
    const rest = after === null ? sorted : sorted.filter(row => row.t > after.t || (row.t === after.t && row.id > after.id));
    const page = rest.slice(0, size);
    const more = rest.length > size;
    return { label: 'observe', route, status: 200, value: { jobs: page.map(row => ({ jobId: row.id })),
      nextCursor: more ? Buffer.from(JSON.stringify(page.at(-1))).toString('base64url') : null, complete: !more } };
  };
  return { requests, get, rows };
}
const ids = (response) => response.value.jobs.map(job => job.jobId);
const row = (n, t = n) => ({ id: `job-${String(n).padStart(3, '0')}`, t });

test('follows the cursor to a complete page and returns each job once in the shape of the complete route', async () => {
  const fake = daemon(Array.from({ length: 25 }, (_, i) => row(i + 1)));
  const response = await getAllJobPages(fake.get, '/api/publisher/jobs', 10);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.value), ['jobs']);
  assert.deepEqual(ids(response), Array.from({ length: 25 }, (_, i) => row(i + 1).id));
  assert.equal(fake.requests.length, 3);
  assert.equal(fake.requests[0], '/api/publisher/jobs?pageSize=10');
  assert.match(fake.requests[1], /^\/api\/publisher\/jobs\?pageSize=10&cursor=/);
  // The first page's request fields stay on the result, so saved evidence keeps its shape.
  assert.equal(response.label, 'observe');
  assert.equal(response.route, '/api/publisher/jobs?pageSize=10');
});

test('asks for the daemon maximum by default and extends a route that already has a query', async () => {
  const fake = daemon([row(1)]);
  await getAllJobPages(fake.get, '/api/publisher/jobs?status=failed');
  assert.deepEqual(fake.requests, [`/api/publisher/jobs?status=failed&pageSize=${JOB_PAGE_SIZE}`]);
  assert.equal(JOB_PAGE_SIZE, 1000);
});

test('an empty list is one complete page', async () => {
  const response = await getAllJobPages(daemon([]).get, '/api/knowledge-assets/swm/share-jobs', 5);
  assert.deepEqual(response, { label: 'observe', route: '/api/knowledge-assets/swm/share-jobs?pageSize=5', status: 200, value: { jobs: [] } });
});

test('complete is never proof of absence: a job admitted behind the walk is missing from it, and a later walk finds it', async () => {
  const fake = daemon(Array.from({ length: 6 }, (_, i) => row(i + 1, 100 + i)));
  const get = async (route) => {
    const page = await fake.get(route);
    // Between the first and the second request one job arrives behind the cursor and one ahead of it.
    if (fake.requests.length === 1) fake.rows.push(row(7, 100), row(8, 999));
    return page;
  };
  const walked = await getAllJobPages(get, '/api/knowledge-assets/swm/share-jobs', 3);
  assert.deepEqual(ids(walked), ['job-001', 'job-002', 'job-003', 'job-004', 'job-005', 'job-006', 'job-008']);
  assert.ok(!ids(walked).includes('job-007'), 'the job behind the cursor is not part of this walk');
  const again = await getAllJobPages(fake.get, '/api/knowledge-assets/swm/share-jobs', 3);
  assert.ok(ids(again).includes('job-007') && ids(again).includes('job-008'));
});

test('a job that changes between pages is listed once', async () => {
  const fake = daemon(Array.from({ length: 6 }, (_, i) => row(i + 1)));
  const get = async (route) => {
    const page = await fake.get(route);
    if (fake.requests.length === 1) fake.rows.find(r => r.id === 'job-002').state = 'finalized';
    return page;
  };
  const walked = await getAllJobPages(get, '/api/publisher/jobs', 4);
  assert.deepEqual(ids(walked), Array.from({ length: 6 }, (_, i) => row(i + 1).id));
});

test('returns the daemon answer unchanged when it is not a page of jobs, mid-walk too', async () => {
  const busy = { status: 503, value: { code: 'STORE_SCHEDULER_BUSY', retryable: true } };
  assert.equal(await getAllJobPages(async () => busy, '/api/publisher/jobs'), busy);
  const fake = daemon(Array.from({ length: 6 }, (_, i) => row(i + 1)));
  let calls = 0;
  const get = async (route) => (++calls === 2 ? busy : fake.get(route));
  assert.equal(await getAllJobPages(get, '/api/publisher/jobs', 2), busy);
  assert.equal(calls, 2);
  // Only a 200 is a page, whatever else the body holds.
  const odd = { status: 206, value: { jobs: [{ jobId: 'a' }], nextCursor: null, complete: true } };
  assert.equal(await getAllJobPages(async () => odd, '/api/publisher/jobs'), odd);
  const failed = { status: null, error: 'timeout' };
  assert.equal(await getAllJobPages(async () => failed, '/api/publisher/jobs'), failed);
});

test('a daemon that predates paging answers its complete list, which is returned as it came', async () => {
  const unpaged = { status: 200, value: { jobs: [{ jobId: 'a' }, { jobId: 'b' }] } };
  let calls = 0;
  const response = await getAllJobPages(async () => { calls += 1; return unpaged; }, '/api/publisher/jobs');
  assert.equal(response, unpaged);
  assert.equal(calls, 1);
});

for (const [name, answers] of [
  ['an incomplete page without a cursor', [{ jobs: [{ jobId: 'a' }], nextCursor: null, complete: false }]],
  ['an incomplete page with an empty cursor', [{ jobs: [{ jobId: 'a' }], nextCursor: '', complete: false }]],
  ['a cursor that does not move on', [{ jobs: [{ jobId: 'a' }], nextCursor: 'x', complete: false }, { jobs: [{ jobId: 'b' }], nextCursor: 'x', complete: false }]],
  ['a later page without the paging fields', [{ jobs: [{ jobId: 'a' }], nextCursor: 'x', complete: false }, { jobs: [{ jobId: 'b' }] }]],
  ['a completeness flag that is not a boolean', [{ jobs: [], nextCursor: null, complete: 'yes' }]],
  // With a fresh cursor the page looks continuable: only the flag stops the walk, so each of these pins the `complete !== false` guard.
  ['a flag that is not a boolean, with a fresh cursor', [{ jobs: [{ jobId: 'a' }], nextCursor: 'x', complete: 'no' }, { jobs: [{ jobId: 'b' }], nextCursor: null, complete: true }]],
  ['the string "false" as the flag, with a fresh cursor', [{ jobs: [{ jobId: 'a' }], nextCursor: 'x', complete: 'false' }, { jobs: [{ jobId: 'b' }], nextCursor: null, complete: true }]],
  ['a missing flag on a later page, with a fresh cursor', [{ jobs: [{ jobId: 'a' }], nextCursor: 'x', complete: false }, { jobs: [{ jobId: 'b' }], nextCursor: 'y' }, { jobs: [{ jobId: 'c' }], nextCursor: null, complete: true }]],
]) {
  test(`throws instead of returning a list it cannot show to be complete: ${name}`, async () => {
    const pages = [...answers];
    await assert.rejects(getAllJobPages(async () => ({ status: 200, value: pages.shift() }), '/api/publisher/jobs'), /the list is not complete/);
  });
}
