// A small GitHub REST client for the repository's CI tooling (the canary alert
// and the weekly CI health report): global fetch, no dependencies. It retries
// server errors and network failures with backoff, waits out primary and
// secondary rate limits (up to a bound, then fails with the reason), and pages
// through list endpoints. `fetch`, `sleep` and `now` are injectable so the
// tests drive every path without a network.

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const SECOND = 1000;

// A non-2xx response that retrying did not fix; `status` lets a caller read a
// 404 or a 5xx as an answer.
export class GitHubRequestError extends Error {
  constructor(method, path, status, detail = '') {
    super(`GitHub API ${method} ${path} returned ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'GitHubRequestError';
    this.status = status;
  }
}

const header = (response, name) => response.headers?.get?.(name) ?? null;

// How long a refused request asks us to wait, in ms, or undefined when the
// refusal is not a rate limit: Retry-After first, then an exhausted primary
// limit's reset time, then GitHub's advice for a secondary limit without
// headers (wait at least a minute).
export function rateLimitDelay(response, detail, now) {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = Number(header(response, 'retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * SECOND;
  if (header(response, 'x-ratelimit-remaining') === '0') {
    const reset = Number(header(response, 'x-ratelimit-reset')) * SECOND;
    if (Number.isFinite(reset) && reset > 0) return Math.max(reset - now, 0) + SECOND;
  }
  if (response.status === 429 || /rate limit/i.test(detail)) return 60 * SECOND;
  return undefined;
}

async function errorDetail(response) {
  try {
    const text = await response.text();
    try {
      return String(JSON.parse(text)?.message ?? text).slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return '';
  }
}

export function createGitHubClient({
  token,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  apiRoot = API_ROOT,
  retries = 4,
  backoffMs = 1000,
  maxWaitMs = 15 * 60 * SECOND,
  log = () => {},
} = {}) {
  if (!token) throw new Error('a GitHub token is required (set GITHUB_TOKEN)');
  let requestCount = 0;
  // The primary limit as the last response reported it: an exhausted one is
  // waited out before the next request instead of being spent on a 403.
  let remaining;
  let resetAt = 0;

  const wait = async (ms, reason) => {
    if (ms > maxWaitMs) {
      throw new Error(`GitHub API ${reason}: waiting ${Math.ceil(ms / SECOND)} s exceeds the ${Math.ceil(maxWaitMs / SECOND)} s bound`);
    }
    log(`GitHub API ${reason}; waiting ${Math.ceil(ms / SECOND)} s`);
    await sleep(ms);
  };

  async function request(method, path, { query, body, retries: attempts = retries } = {}) {
    const url = new URL(path.startsWith('https://') ? path : `${apiRoot}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const label = `${method} ${url.pathname}`;
    let failures = 0;
    let limited = 0;
    for (;;) {
      if (remaining === 0 && resetAt > now()) {
        await wait(resetAt - now() + SECOND, `rate limit exhausted before ${label}`);
        remaining = undefined;
      }
      requestCount += 1;
      let response;
      let data;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': 'dkg-ci-tooling',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        // A large body can be cut off mid-stream ("terminated"): reading it is
        // part of the attempt.
        if (response.ok) data = response.status === 204 ? null : JSON.parse(await response.text());
      } catch (error) {
        if (failures >= attempts) throw new Error(`GitHub API ${label} failed: ${error.message}`);
        await wait(backoffMs * 2 ** failures, `${label} failed (${error.message})`);
        failures += 1;
        continue;
      }
      const remainingHeader = header(response, 'x-ratelimit-remaining');
      if (remainingHeader !== null) {
        remaining = Number(remainingHeader);
        resetAt = Number(header(response, 'x-ratelimit-reset')) * SECOND || 0;
      }
      if (response.ok) return data;
      const detail = await errorDetail(response);
      const delay = rateLimitDelay(response, detail, now());
      if (delay !== undefined && limited < retries) {
        limited += 1;
        remaining = undefined;
        await wait(delay, `${label} rate limited (${response.status})`);
        continue;
      }
      if (response.status >= 500 && failures < attempts) {
        await wait(backoffMs * 2 ** failures, `${label} returned ${response.status}`);
        failures += 1;
        continue;
      }
      throw new GitHubRequestError(method, url.pathname, response.status, detail);
    }
  }

  // Every item of a list endpoint, `per_page` at a time. `itemsKey` names the
  // array in an object page (workflow_runs, jobs); `totalCount` is the
  // endpoint's total_count when it reports one. `retries` overrides the
  // client's server-error retries for each page.
  async function paginate(path, { query = {}, itemsKey, perPage = 100, retries: attempts } = {}) {
    const items = [];
    let totalCount;
    for (let page = 1; ; page += 1) {
      const data = await request('GET', path, { query: { ...query, per_page: perPage, page }, retries: attempts });
      const pageItems = itemsKey ? data?.[itemsKey] : data;
      if (!Array.isArray(pageItems)) throw new Error(`GitHub API ${path} returned a page without ${itemsKey ?? 'an array'}`);
      if (itemsKey && Number.isInteger(data.total_count)) totalCount = data.total_count;
      items.push(...pageItems);
      if (pageItems.length < perPage || (totalCount !== undefined && items.length >= totalCount)) return { items, totalCount };
    }
  }

  return {
    request,
    paginate,
    get requestCount() {
      return requestCount;
    },
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const DAY = 86_400_000;
// GitHub returns at most this many runs for one `created` search.
const RUN_SEARCH_LIMIT = 1000;

// Every run of `workflow` created in [since, until), oldest first. A
// `created` search returns at most 1000 runs, so the window is read a day at
// a time and a day that reaches the cap is split in half until each part fits.
export async function listWorkflowRuns(client, { repo, workflow, since, until, query = {} }) {
  const runs = new Map();
  const path = `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const read = async (from, to) => {
    const { items, totalCount = items.length } = await client.paginate(path, {
      query: { ...query, created: `${iso(from)}..${iso(to)}` },
      itemsKey: 'workflow_runs',
    });
    if (totalCount >= RUN_SEARCH_LIMIT && to - from > 2 * SECOND) {
      const middle = from + Math.floor((to - from) / 2 / SECOND) * SECOND;
      await read(from, middle);
      await read(middle + SECOND, to);
      return;
    }
    for (const run of items) runs.set(run.id, run);
  };
  // `created` ranges are inclusive at whole seconds.
  for (let from = since; from < until; from += DAY) await read(from, Math.min(from + DAY, until) - SECOND);
  return [...runs.values()]
    .filter((run) => Date.parse(run.created_at) >= since && Date.parse(run.created_at) < until)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
}

// The jobs of a run: every attempt's (`filter=all`), or one attempt's. A
// listing that keeps failing with a server error is read again in smaller
// pages: GitHub has answered 502 for a full 100-job page of a re-run run
// while 50-job pages of the same listing succeed, so a larger page gets one
// retry before the next size and only the smallest the client's full budget.
export async function listRunJobs(client, { repo, runId, attempt, pageSizes = [100, 50, 25], log = () => {} }) {
  const path = attempt === undefined
    ? `repos/${repo}/actions/runs/${runId}/jobs`
    : `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`;
  const query = attempt === undefined ? { filter: 'all' } : {};
  for (const [index, perPage] of pageSizes.entries()) {
    const last = index === pageSizes.length - 1;
    try {
      return (await client.paginate(path, { query, itemsKey: 'jobs', perPage, retries: last ? undefined : 1 })).items;
    } catch (error) {
      const next = pageSizes[index + 1];
      if (!(error instanceof GitHubRequestError) || error.status < 500 || next === undefined) throw error;
      log(`${path} kept failing with ${error.status}; reading it ${next} jobs at a time`);
    }
  }
  throw new Error('listRunJobs needs at least one page size');
}

// Issues and labels, for the alert and report issues.
export async function ensureLabel(client, repo, { name, color, description }) {
  try {
    await client.request('GET', `repos/${repo}/labels/${encodeURIComponent(name)}`);
    return false;
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || error.status !== 404) throw error;
  }
  try {
    await client.request('POST', `repos/${repo}/labels`, { body: { name, color, description } });
    return true;
  } catch (error) {
    // Another writer created it first.
    if (error instanceof GitHubRequestError && error.status === 422) return false;
    throw error;
  }
}

// The oldest open issue with `label` whose body carries `marker`; the issues
// endpoint also lists pull requests, which never match.
export async function findOpenIssue(client, repo, { label, marker }) {
  const { items } = await client.paginate(`repos/${repo}/issues`, {
    query: { labels: label, state: 'open', sort: 'created', direction: 'asc' },
  });
  return items.find((issue) => !issue.pull_request && String(issue.body ?? '').includes(marker)) ?? null;
}
