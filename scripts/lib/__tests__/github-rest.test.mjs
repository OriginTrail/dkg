// The CI tooling's GitHub REST client (github-rest.mjs) against a scripted
// fetch: retries, rate limits, pagination, run search splitting and the
// smaller-page fallback for job listings.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGitHubClient,
  ensureLabel,
  findOpenIssue,
  GitHubRequestError,
  listRunJobs,
  listWorkflowRuns,
  rateLimitDelay,
} from '../github-rest.mjs';

// A fetch that answers each call with the next scripted response (or a
// function of the request) and records what was asked.
function scriptedFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    const answer = typeof next === 'function' ? next(new URL(url), init) : next;
    if (answer instanceof Error) throw answer;
    const { status = 200, body = {}, headers = {}, cutOff = false } = answer;
    // A body the server stops sending part-way, as undici reports it.
    if (cutOff) return { ok: true, status, headers: new Headers(headers), text: async () => { throw new TypeError('terminated'); } };
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

function client(responses, options = {}) {
  const sleeps = [];
  const { fetch, calls } = scriptedFetch(responses);
  const github = createGitHubClient({ token: 'test-token', fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => 1_000_000, ...options });
  return { github, calls, sleeps };
}

test('requests carry the token and API version, and decode JSON or no content', async () => {
  const { github, calls } = client([{ body: { ok: 1 } }, { status: 204 }]);
  assert.deepEqual(await github.request('GET', 'repos/o/r/labels/x', { query: { a: 1, skipped: undefined } }), { ok: 1 });
  assert.equal(await github.request('PATCH', '/repos/o/r/issues/1', { body: { state: 'closed' } }), null);
  assert.equal(calls[0].url.href, 'https://api.github.com/repos/o/r/labels/x?a=1');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.deepEqual(calls[1].body, { state: 'closed' });
  assert.equal(github.requestCount, 2);
  assert.throws(() => createGitHubClient({ token: '' }), /token is required/);
});

test('server errors, network failures and cut-off bodies are retried with backoff, then reported', async () => {
  const { github, sleeps } = client([{ status: 502 }, new Error('socket hang up'), { cutOff: true }, { status: 503 }, { body: [1] }]);
  assert.deepEqual(await github.request('GET', 'x'), [1]);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);

  const failing = client(Array.from({ length: 5 }, () => ({ status: 500, body: { message: 'boom' } })));
  await assert.rejects(failing.github.request('GET', 'x'), (error) => error instanceof GitHubRequestError && error.status === 500 && /boom/.test(error.message));
  assert.equal(failing.sleeps.length, 4);

  // A client error is an answer, not a reason to retry.
  const missing = client([{ status: 404, body: { message: 'Not Found' } }]);
  await assert.rejects(missing.github.request('GET', 'x'), (error) => error.status === 404);
  assert.deepEqual(missing.sleeps, []);

  // A PATCH sets a whole body or state, so it is repeated like a read.
  const patch = client([{ status: 502 }, new Error('socket hang up'), { body: { number: 5 } }]);
  assert.deepEqual(await patch.github.request('PATCH', 'repos/o/r/issues/5', { body: { state: 'closed' } }), { number: 5 });
  assert.equal(patch.calls.length, 3);
});

test('a POST goes out once: a write whose answer is lost is reported, never repeated', async () => {
  // GitHub creates the issue, then the answer is cut off: one issue, and an error.
  let created = 0;
  const createThenLose = () => {
    created += 1;
    return { status: 201, cutOff: true };
  };
  const lost = client([createThenLose, createThenLose]);
  await assert.rejects(lost.github.request('POST', 'repos/o/r/issues', { body: { title: 't' } }), /failed: terminated \(not repeated: the write may have happened\)/);
  assert.equal(created, 1);
  assert.equal(lost.calls.length, 1);
  assert.deepEqual(lost.sleeps, []);
  // Nor after a lost connection, a server error or a rate-limit refusal.
  for (const answer of [new Error('socket hang up'), { status: 502 }, { status: 429, headers: { 'retry-after': '1' } }]) {
    const once = client([answer, { status: 201, body: { number: 2 } }]);
    await assert.rejects(once.github.request('POST', 'repos/o/r/issues/1/comments', { body: { body: 'b' } }));
    assert.equal(once.calls.length, 1, String(answer.status ?? answer.message));
    assert.deepEqual(once.sleeps, []);
  }
  // A read after the same failures is still repeated.
  const read = client([{ cutOff: true }, { status: 502 }, { status: 429, headers: { 'retry-after': '1' } }, { body: [1] }]);
  assert.deepEqual(await read.github.request('GET', 'repos/o/r/issues'), [1]);
  assert.deepEqual(read.sleeps, [1000, 2000, 1000]);
});

test('rate limits are waited out: Retry-After, an exhausted primary limit, and a bare secondary limit', async () => {
  const now = 1_000_000;
  const response = (status, headers) => new Response('{}', { status, headers });
  assert.equal(rateLimitDelay(response(429, { 'retry-after': '7' }), '', now), 7000);
  assert.equal(rateLimitDelay(response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 30) }), '', now), 31_000);
  assert.equal(rateLimitDelay(response(403, {}), 'You have exceeded a secondary rate limit', now), 60_000);
  assert.equal(rateLimitDelay(response(403, {}), 'Resource not accessible by integration', now), undefined);
  assert.equal(rateLimitDelay(response(500, { 'retry-after': '7' }), '', now), undefined);

  const { github, sleeps } = client([
    { status: 403, headers: { 'retry-after': '2' }, body: { message: 'secondary rate limit' } },
    { body: { done: true } },
  ]);
  assert.deepEqual(await github.request('GET', 'x'), { done: true });
  assert.deepEqual(sleeps, [2000]);

  // An exhausted limit reported on a success is waited out before the next
  // request rather than spent on a 403.
  const polite = client([
    { body: 1, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1_000_000 / 1000 + 10) } },
    { body: 2 },
  ]);
  await polite.github.request('GET', 'x');
  await polite.github.request('GET', 'y');
  assert.deepEqual(polite.sleeps, [11_000]);

  // A wait past the bound fails with the reason instead of hanging the job.
  const bounded = client([{ status: 429, headers: { 'retry-after': '3600' } }], { maxWaitMs: 60_000 });
  await assert.rejects(bounded.github.request('GET', 'x'), /exceeds the 60 s bound/);
});

test('a deadline stops a wait that would pass it and any request after it, and aborts each request at it', async () => {
  let clock = 1_000_000;
  const signals = [];
  const { fetch } = scriptedFetch([{ status: 502 }, { status: 502 }, { body: 1 }]);
  const recording = (url, init) => { signals.push(init.signal); return fetch(url, init); };
  const github = createGitHubClient({ token: 't', fetch: recording, deadlineMs: 5_000, backoffMs: 2_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  // 502, a 2 s wait; 502, and a 4 s wait would end past the 5 s deadline.
  await assert.rejects(github.request('GET', 'x'), /waiting 4 s would pass the client's 5 s deadline/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  clock += 10_000;
  await assert.rejects(github.request('GET', 'y'), /GET \/y: the client's 5 s deadline has passed/);
  assert.equal(signals.length, 2, 'no request starts after the deadline');
  // Without a deadline a request carries no signal.
  const plain = createGitHubClient({ token: 't', fetch: recording });
  assert.equal(await plain.request('GET', 'z'), 1);
  assert.equal(signals[2], undefined);
});

test('a request still in flight at the deadline is aborted then, in real time', { timeout: 10_000 }, async () => {
  // A server that never answers: the request settles only if its signal
  // aborts. A real request's socket keeps the process alive until then; this
  // fake has none, and the abort's timer does not hold the process, so a
  // timer outlasting the test does. Without the abort the test times out.
  const keepAlive = setTimeout(() => {}, 20_000);
  try {
    let signal;
    const stalled = (url, init) => new Promise((resolve, reject) => {
      signal = init.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const github = createGitHubClient({ token: 't', fetch: stalled, deadlineMs: 300 });
    const started = Date.now();
    await assert.rejects(github.request('GET', 'x'), /deadline/);
    const elapsed = Date.now() - started;
    assert.equal(signal?.aborted, true);
    assert.equal(signal.reason?.name, 'TimeoutError');
    assert.ok(elapsed >= 250 && elapsed < 5_000, `aborted after ${elapsed} ms`);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('pagination reads every page of arrays and of object pages, stopping at the total', async () => {
  const page = (count, offset = 0) => Array.from({ length: count }, (_, index) => offset + index);
  const arrays = client([{ body: page(2) }, { body: page(2, 2) }, { body: page(1, 4) }]);
  assert.deepEqual((await arrays.github.paginate('repos/o/r/issues', { perPage: 2 })).items, [0, 1, 2, 3, 4]);
  assert.deepEqual(arrays.calls.map(({ url }) => url.searchParams.get('page')), ['1', '2', '3']);
  assert.ok(arrays.calls.every(({ url }) => url.searchParams.get('per_page') === '2'));

  const objects = client([{ body: { total_count: 4, jobs: page(2) } }, { body: { total_count: 4, jobs: page(2, 2) } }]);
  assert.deepEqual(await objects.github.paginate('jobs', { itemsKey: 'jobs', perPage: 2 }), { items: [0, 1, 2, 3], totalCount: 4 });
  assert.equal(objects.calls.length, 2, 'a full last page at total_count ends the listing');

  const malformed = client([{ body: { message: 'nope' } }]);
  await assert.rejects(malformed.github.paginate('jobs', { itemsKey: 'jobs' }), /without jobs/);
});

test('a run search splits a range that reaches the 1000-run cap before paging past it, and recovers every run once', async () => {
  // GitHub's run search: newest first, 100 a page, and nothing past result
  // 1000 of one query. Nov 1 has 1150 runs, Nov 2 exactly 1000 (GitHub may
  // report the cap itself), one a minute from midnight; Oct 31 has one.
  const since = Date.parse('2026-11-01T00:00:00Z');
  const until = since + 2 * 86_400_000;
  const minute = (day, index) => new Date(since + day * 86_400_000 + index * 60_000).toISOString().replace('.000Z', 'Z');
  const all = [
    { id: 1, created_at: '2026-10-31T23:00:00Z' },
    ...Array.from({ length: 1150 }, (_, index) => ({ id: 1000 + index, created_at: minute(0, index) })),
    ...Array.from({ length: 1000 }, (_, index) => ({ id: 5000 + index, created_at: minute(1, index) })),
  ];
  const asked = [];
  const answer = (url) => {
    const [from, to] = url.searchParams.get('created').split('..');
    const page = Number(url.searchParams.get('page'));
    const perPage = Number(url.searchParams.get('per_page'));
    asked.push(`${from}..${to} page ${page}`);
    if (perPage !== 100) throw new Error(`per_page ${perPage}`);
    if ((page - 1) * perPage >= 1000) throw new Error(`asked for page ${page} of ${from}..${to}, past the 1000-result cap`);
    const matching = all.filter(({ created_at: created }) => created >= from && created <= to).reverse();
    return { body: { total_count: matching.length, workflow_runs: matching.slice((page - 1) * perPage, page * perPage) } };
  };
  const { github } = client(Array.from({ length: 40 }, () => answer));
  const runs = await listWorkflowRuns(github, { repo: 'o/r', workflow: 'ci.yml', since, until });
  assert.deepEqual(runs.map(({ id }) => id), all.slice(1).map(({ id }) => id), 'every run in the window, once, oldest first');
  // Each capped day was split after its first page, and each half paged to its end.
  assert.deepEqual(asked.filter((entry) => entry.endsWith(' page 1')), [
    '2026-11-01T00:00:00Z..2026-11-01T23:59:59Z page 1',
    '2026-11-01T00:00:00Z..2026-11-01T11:59:59Z page 1',
    '2026-11-01T12:00:00Z..2026-11-01T23:59:59Z page 1',
    '2026-11-02T00:00:00Z..2026-11-02T23:59:59Z page 1',
    '2026-11-02T00:00:00Z..2026-11-02T11:59:59Z page 1',
    '2026-11-02T12:00:00Z..2026-11-02T23:59:59Z page 1',
  ]);
  assert.equal(asked.filter((entry) => entry.startsWith('2026-11-01T00:00:00Z..2026-11-01T11:59:59Z')).length, 8, '720 runs, 8 pages');
  for (const day of ['2026-11-01', '2026-11-02']) {
    const whole = `${day}T00:00:00Z..${day}T23:59:59Z`;
    assert.deepEqual(asked.filter((entry) => entry.startsWith(`${whole} `)), [`${whole} page 1`], 'a capped day is never paged');
  }
  // A range that cannot be split further and still reaches the cap is an error, not a silent gap.
  const crowded = client([() => ({ body: { total_count: 1000, workflow_runs: [] } })]);
  await assert.rejects(listWorkflowRuns(crowded.github, { repo: 'o/r', workflow: 'ci.yml', since, until: since + 1000 }), /more than one search can list/);
});

test('a job listing that keeps failing with a server error is read again in smaller pages', async () => {
  const jobs = (count) => ({ body: { total_count: count, jobs: Array.from({ length: count }, (_, index) => ({ id: index })) } });
  const logged = [];
  const { github, calls, sleeps } = client([{ status: 502 }, { status: 502 }, jobs(50)]);
  const listed = await listRunJobs(github, { repo: 'o/r', runId: 7, log: (message) => logged.push(message) });
  assert.equal(listed.length, 50);
  assert.deepEqual(calls.map(({ url }) => `${url.pathname} ${url.searchParams.get('filter')} ${url.searchParams.get('per_page')}`), [
    '/repos/o/r/actions/runs/7/jobs all 100',
    '/repos/o/r/actions/runs/7/jobs all 100',
    '/repos/o/r/actions/runs/7/jobs all 50',
  ]);
  assert.deepEqual(sleeps, [1000], 'one retry, then a smaller page');
  assert.match(logged.at(-1), /reading it 50 jobs at a time/);
  // The smallest page keeps the client's whole retry budget before failing.
  const down = client([...Array.from({ length: 4 }, () => ({ status: 502 })), ...Array.from({ length: 5 }, () => ({ status: 502 }))]);
  await assert.rejects(listRunJobs(down.github, { repo: 'o/r', runId: 7 }), (error) => error.status === 502);
  assert.equal(down.calls.length, 2 + 2 + 5);

  // One attempt's jobs come from the attempt endpoint; a client error is not retried smaller.
  const attempt = client([jobs(3)]);
  await listRunJobs(attempt.github, { repo: 'o/r', runId: 7, attempt: 2 });
  assert.equal(attempt.calls[0].url.pathname, '/repos/o/r/actions/runs/7/attempts/2/jobs');
  assert.equal(attempt.calls[0].url.searchParams.get('filter'), null);
  const denied = client([{ status: 403, body: { message: 'Resource not accessible' } }]);
  await assert.rejects(listRunJobs(denied.github, { repo: 'o/r', runId: 7 }), (error) => error.status === 403);
});

test('labels are created once, and the open issue is the oldest one with the marker', async () => {
  const exists = client([{ body: { name: 'ci-alert' } }]);
  assert.equal(await ensureLabel(exists.github, 'o/r', { name: 'ci-alert', color: 'b60205', description: 'd' }), false);
  const created = client([{ status: 404 }, { status: 201, body: {} }]);
  assert.equal(await ensureLabel(created.github, 'o/r', { name: 'ci alert', color: 'b60205', description: 'd' }), true);
  assert.equal(created.calls[0].url.pathname, '/repos/o/r/labels/ci%20alert');
  assert.deepEqual(created.calls[1].body, { name: 'ci alert', color: 'b60205', description: 'd' });
  const raced = client([{ status: 404 }, { status: 422, body: { message: 'already_exists' } }]);
  assert.equal(await ensureLabel(raced.github, 'o/r', { name: 'x', color: '000000', description: 'd' }), false);

  const issues = client([{ body: [
    { number: 3, body: 'no marker' },
    { number: 4, body: '<!-- m -->', pull_request: {} },
    { number: 5, body: 'x <!-- m --> y' },
    { number: 6, body: '<!-- m -->' },
  ] }]);
  assert.equal((await findOpenIssue(issues.github, 'o/r', { label: 'ci-alert', marker: '<!-- m -->' })).number, 5);
  assert.deepEqual(Object.fromEntries(issues.calls[0].url.searchParams), {
    labels: 'ci-alert', state: 'open', sort: 'created', direction: 'asc', per_page: '100', page: '1',
  });
  const none = client([{ body: [] }]);
  assert.equal(await findOpenIssue(none.github, 'o/r', { label: 'ci-alert', marker: 'm' }), null);
});
