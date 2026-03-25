/**
 * Unit tests for src/github/client.ts
 *
 * All HTTP calls are mocked via vi.spyOn(globalThis, 'fetch').
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHubClient, GitHubApiError } from '../src/github/client.js';
import {
  sampleRepository,
  samplePullRequest,
  sampleReview,
  sampleIssue,
  sampleCommit,
} from './helpers/index.js';

const TOKEN = 'ghp_test_token_123';

function rateLimitHeaders(remaining = 4999, limit = 5000, reset = 9999999999) {
  return {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(reset),
    'x-ratelimit-used': String(limit - remaining),
  };
}

function makeResponse(body: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...rateLimitHeaders(),
    ...extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Error', headers });
}

function makeErrorResponse(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...rateLimitHeaders(),
    ...extraHeaders,
  });
  return new Response(JSON.stringify({ message }), { status, statusText: 'Error', headers });
}

describe('GitHubClient', () => {
  let client: GitHubClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new GitHubClient({ token: TOKEN });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // =========================================================================
  // Request basics
  // =========================================================================

  describe('request headers', () => {
    it('sends Authorization Bearer token', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleRepository));
      await client.getRepository('octocat', 'Hello-World');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('sends Accept and API version headers', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleRepository));
      await client.getRepository('octocat', 'Hello-World');

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Accept']).toBe('application/vnd.github+json');
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    });

    it('uses default GitHub API base URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleRepository));
      await client.getRepository('octocat', 'Hello-World');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/repos/octocat/Hello-World');
    });

    it('supports custom base URL', async () => {
      const customClient = new GitHubClient({ token: TOKEN, baseUrl: 'https://git.corp.com/api/v3' });
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleRepository));
      await customClient.getRepository('org', 'repo');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://git.corp.com/api/v3/repos/org/repo');
    });

    it('strips trailing slash from custom base URL', async () => {
      const customClient = new GitHubClient({ token: TOKEN, baseUrl: 'https://git.corp.com/api/v3/' });
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleRepository));
      await customClient.getRepository('org', 'repo');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://git.corp.com/api/v3/repos/org/repo');
    });
  });

  // =========================================================================
  // Repository
  // =========================================================================

  describe('getRepository', () => {
    it('fetches repository data from correct URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleRepository));
      const result = await client.getRepository('octocat', 'Hello-World');

      expect(result.full_name).toBe('octocat/Hello-World');
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World');
    });
  });

  // =========================================================================
  // Pull Requests
  // =========================================================================

  describe('listPullRequests', () => {
    it('constructs URL with default per_page', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([samplePullRequest]));
      const result = await client.listPullRequests('octocat', 'Hello-World');

      expect(result).toHaveLength(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/pulls');
      expect(url).toContain('per_page=30');
    });

    it('passes state, sort, direction, page query params', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));
      await client.listPullRequests('octocat', 'Hello-World', {
        state: 'closed',
        sort: 'updated',
        direction: 'asc',
        page: 2,
        perPage: 50,
      });

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('state=closed');
      expect(url).toContain('sort=updated');
      expect(url).toContain('direction=asc');
      expect(url).toContain('page=2');
      expect(url).toContain('per_page=50');
    });
  });

  describe('getPullRequest', () => {
    it('fetches single PR by number', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(samplePullRequest));
      const result = await client.getPullRequest('octocat', 'Hello-World', 42);

      expect(result.number).toBe(42);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/pulls/42');
    });
  });

  describe('getPullRequestReviews', () => {
    it('fetches reviews for a PR', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([sampleReview]));
      const result = await client.getPullRequestReviews('octocat', 'Hello-World', 42);

      expect(result).toHaveLength(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/pulls/42/reviews');
    });
  });

  describe('getPullRequestFiles', () => {
    it('fetches files for a PR', async () => {
      const files = [{ filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2 }];
      fetchSpy.mockResolvedValueOnce(makeResponse(files));
      const result = await client.getPullRequestFiles('octocat', 'Hello-World', 42);

      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('src/index.ts');
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/pulls/42/files');
    });
  });

  describe('getPullRequestComments', () => {
    it('fetches review comments for a PR', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));
      const result = await client.getPullRequestComments('octocat', 'Hello-World', 42);

      expect(result).toHaveLength(0);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/pulls/42/comments');
    });
  });

  // =========================================================================
  // Issues
  // =========================================================================

  describe('listIssues', () => {
    it('constructs URL with default per_page', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([sampleIssue]));
      const result = await client.listIssues('octocat', 'Hello-World');

      expect(result).toHaveLength(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/issues');
      expect(url).toContain('per_page=30');
    });

    it('passes state, labels, since, sort, direction, page query params', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));
      await client.listIssues('octocat', 'Hello-World', {
        state: 'all',
        labels: 'bug,enhancement',
        since: '2024-01-01T00:00:00Z',
        sort: 'comments',
        direction: 'desc',
        page: 3,
        perPage: 10,
      });

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('state=all');
      expect(url).toContain('labels=bug%2Cenhancement');
      expect(url).toContain('since=2024-01-01T00%3A00%3A00Z');
      expect(url).toContain('sort=comments');
      expect(url).toContain('direction=desc');
      expect(url).toContain('page=3');
      expect(url).toContain('per_page=10');
    });
  });

  describe('getIssue', () => {
    it('fetches single issue by number', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleIssue));
      const result = await client.getIssue('octocat', 'Hello-World', 10);

      expect(result.number).toBe(10);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/issues/10');
    });
  });

  describe('getIssueComments', () => {
    it('fetches comments for an issue', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));
      await client.getIssueComments('octocat', 'Hello-World', 10);

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/issues/10/comments');
    });
  });

  // =========================================================================
  // Commits
  // =========================================================================

  describe('listCommits', () => {
    it('constructs URL with default per_page', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([sampleCommit]));
      const result = await client.listCommits('octocat', 'Hello-World');

      expect(result).toHaveLength(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/commits');
      expect(url).toContain('per_page=30');
    });

    it('passes sha, since, until query params', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));
      await client.listCommits('octocat', 'Hello-World', {
        sha: 'main',
        since: '2024-01-01T00:00:00Z',
        until: '2024-02-01T00:00:00Z',
      });

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('sha=main');
      expect(url).toContain('since=');
      expect(url).toContain('until=');
    });
  });

  describe('getCommit', () => {
    it('fetches single commit by sha', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(sampleCommit));
      const result = await client.getCommit('octocat', 'Hello-World', 'abc123');

      expect(result.sha).toBeTruthy();
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/commits/abc123');
    });
  });

  // =========================================================================
  // Branches
  // =========================================================================

  describe('listBranches', () => {
    it('constructs URL with default per_page of 100', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));
      await client.listBranches('octocat', 'Hello-World');

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/repos/octocat/Hello-World/branches');
      expect(url).toContain('per_page=100');
    });

    it('accepts pagination options', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));
      await client.listBranches('octocat', 'Hello-World', { perPage: 50, page: 2 });

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('per_page=50');
      expect(url).toContain('page=2');
    });
  });

  // =========================================================================
  // Token validation
  // =========================================================================

  describe('validateToken', () => {
    it('returns valid: true with login on success', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(
        { login: 'octocat' },
        200,
        { ...rateLimitHeaders(), 'x-oauth-scopes': 'repo, read:org' },
      ));
      const result = await client.validateToken();

      expect(result.valid).toBe(true);
      expect(result.login).toBe('octocat');
      expect(result.scopes).toContain('repo');
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/user');
    });

    it('returns valid: false with error on 401 unauthorized', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(401, 'Bad credentials'));
      const result = await client.validateToken();

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid token');
      expect(result.login).toBeUndefined();
    });

    it('falls back to /rate_limit on 403 (fine-grained PAT)', async () => {
      // First call: GET /user returns 403 (no user scope)
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(403, 'Resource not accessible by personal access token'));
      // Second call: GET /rate_limit returns authenticated rate (5000)
      fetchSpy.mockResolvedValueOnce(makeResponse(
        { rate: { limit: 5000, remaining: 4999, reset: 9999999999, used: 1 } },
      ));

      const result = await client.validateToken();

      expect(result.valid).toBe(true);
      expect(result.login).toBe('(fine-grained PAT)');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns valid: false when 403 and rate_limit shows unauthenticated', async () => {
      // First call: GET /user returns 403
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(403, 'Resource not accessible'));
      // Second call: GET /rate_limit returns unauthenticated rate (60)
      fetchSpy.mockResolvedValueOnce(makeResponse(
        { rate: { limit: 60, remaining: 59, reset: 9999999999, used: 1 } },
      ));

      const result = await client.validateToken();

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token lacks required permissions');
    });

    it('returns valid: false when 403 and rate_limit also fails', async () => {
      // First call: GET /user returns 403
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(403, 'Resource not accessible'));
      // Second call: GET /rate_limit also fails
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(401, 'Bad credentials'));

      const result = await client.validateToken();

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token lacks required permissions');
    });

    it('throws on non-401/non-403 errors', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(500, 'Internal server error'));

      await expect(client.validateToken()).rejects.toThrow(GitHubApiError);
    });
  });

  // =========================================================================
  // Rate limit handling
  // =========================================================================

  describe('rate limit handling', () => {
    it('tracks rate limit info from response headers', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(
        sampleRepository,
        200,
        rateLimitHeaders(4990, 5000, 1700000000),
      ));
      await client.getRepository('octocat', 'Hello-World');

      const info = client.getRateLimit();
      expect(info).not.toBeNull();
      expect(info!.limit).toBe(5000);
      expect(info!.remaining).toBe(4990);
      expect(info!.reset).toBe(1700000000);
      expect(info!.used).toBe(10);
    });

    it('returns null rate limit before any request', () => {
      expect(client.getRateLimit()).toBeNull();
    });

    it('throws GitHubApiError with rate limit message on 403 with remaining=0', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(
        JSON.stringify({ message: 'API rate limit exceeded' }),
        {
          status: 403,
          statusText: 'Forbidden',
          headers: new Headers({
            'Content-Type': 'application/json',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
            'x-ratelimit-used': '5000',
          }),
        },
      ));

      try {
        await client.getRepository('octocat', 'Hello-World');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        const apiErr = err as GitHubApiError;
        expect(apiErr.status).toBe(403);
        expect(apiErr.message).toContain('rate limit');
        expect(apiErr.isRateLimited).toBe(true);
      }
    });

    it('throws on exhausted rate limit with long wait (>120s)', async () => {
      // Prime the rate limit info with remaining=0 and reset far in the future
      fetchSpy.mockResolvedValueOnce(makeResponse(
        sampleRepository,
        200,
        rateLimitHeaders(0, 5000, Math.floor(Date.now() / 1000) + 300),
      ));
      await client.getRepository('octocat', 'Hello-World');

      // Next request should throw because remaining=0 and wait > 120s
      await expect(client.getRepository('octocat', 'Hello-World')).rejects.toThrow(
        /Rate limit exhausted/,
      );
    });
  });

  // =========================================================================
  // ETag caching
  // =========================================================================

  describe('ETag caching', () => {
    it('caches response with ETag and sends If-None-Match on repeat', async () => {
      // First request returns data with an ETag
      fetchSpy.mockResolvedValueOnce(makeResponse(
        sampleRepository,
        200,
        { ...rateLimitHeaders(), 'etag': '"abc123"' },
      ));
      const first = await client.getRepository('octocat', 'Hello-World');
      expect(first.full_name).toBe('octocat/Hello-World');

      // Allow cache to populate (the clone().json() is async)
      await new Promise(r => setTimeout(r, 10));

      // Second request returns 304 Not Modified
      fetchSpy.mockResolvedValueOnce(new Response(null, {
        status: 304,
        statusText: 'Not Modified',
        headers: new Headers(rateLimitHeaders()),
      }));
      const second = await client.getRepository('octocat', 'Hello-World');
      expect(second.full_name).toBe('octocat/Hello-World');

      // Verify If-None-Match was sent
      const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const headers = secondInit.headers as Record<string, string>;
      expect(headers['If-None-Match']).toBe('"abc123"');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('throws GitHubApiError on 404', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));

      try {
        await client.getRepository('nonexistent', 'repo');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        const apiErr = err as GitHubApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.isNotFound).toBe(true);
        expect(apiErr.isUnauthorized).toBe(false);
        expect(apiErr.isRateLimited).toBe(false);
      }
    });

    it('throws GitHubApiError on 401', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(401, 'Bad credentials'));

      try {
        await client.getRepository('octocat', 'Hello-World');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        const apiErr = err as GitHubApiError;
        expect(apiErr.status).toBe(401);
        expect(apiErr.isUnauthorized).toBe(true);
      }
    });

    it('throws GitHubApiError on 500', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(500, 'Internal Server Error'));

      try {
        await client.getRepository('octocat', 'Hello-World');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubApiError);
        const apiErr = err as GitHubApiError;
        expect(apiErr.status).toBe(500);
      }
    });

    it('includes response body in error', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(422, 'Validation Failed'));

      try {
        await client.getRepository('octocat', 'Hello-World');
        expect.fail('Should have thrown');
      } catch (err) {
        const apiErr = err as GitHubApiError;
        expect(apiErr.response).toBeDefined();
        expect(apiErr.response.message).toBe('Validation Failed');
      }
    });

    it('uses status text when response body has no message', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('not json', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: new Headers(rateLimitHeaders()),
      }));

      try {
        await client.getRepository('octocat', 'Hello-World');
        expect.fail('Should have thrown');
      } catch (err) {
        const apiErr = err as GitHubApiError;
        expect(apiErr.status).toBe(502);
        expect(apiErr.message).toContain('502');
      }
    });
  });

  // =========================================================================
  // Pagination
  // =========================================================================

  describe('pagination', () => {
    it('paginate yields pages until results < perPage', async () => {
      const page1 = Array.from({ length: 2 }, (_, i) => ({ id: i + 1 }));
      const page2 = [{ id: 3 }]; // fewer than perPage=2, so pagination stops

      fetchSpy.mockResolvedValueOnce(makeResponse(page1, 200, {
        ...rateLimitHeaders(),
        'link': '<https://api.github.com/?page=2>; rel="next"',
      }));
      fetchSpy.mockResolvedValueOnce(makeResponse(page2));

      const pages: any[][] = [];
      for await (const page of client.paginate('/repos/o/r/pulls', { perPage: 2 })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0]).toHaveLength(2);
      expect(pages[1]).toHaveLength(1);
    });

    it('paginate stops when link header has no rel="next"', async () => {
      const fullPage = Array.from({ length: 10 }, (_, i) => ({ id: i }));

      fetchSpy.mockResolvedValueOnce(makeResponse(fullPage, 200, {
        ...rateLimitHeaders(),
        // No link header — no next page
      }));

      const pages: any[][] = [];
      for await (const page of client.paginate('/repos/o/r/pulls', { perPage: 10 })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
    });

    it('paginate follows link header rel="next"', async () => {
      const page1 = Array.from({ length: 3 }, (_, i) => ({ id: i }));
      const page2 = [{ id: 3 }];

      fetchSpy.mockResolvedValueOnce(makeResponse(page1, 200, {
        ...rateLimitHeaders(),
        'link': '<https://api.github.com/repos/o/r/pulls?per_page=3&page=2>; rel="next"',
      }));
      fetchSpy.mockResolvedValueOnce(makeResponse(page2));

      const pages: any[][] = [];
      for await (const page of client.paginate('/repos/o/r/pulls', { perPage: 3 })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
    });

    it('fetchAllPages collects all items into a flat array', async () => {
      const page1 = [{ id: 1 }, { id: 2 }];
      const page2 = [{ id: 3 }];

      fetchSpy.mockResolvedValueOnce(makeResponse(page1, 200, {
        ...rateLimitHeaders(),
        'link': '<https://api.github.com/?page=2>; rel="next"',
      }));
      fetchSpy.mockResolvedValueOnce(makeResponse(page2));

      const all = await client.fetchAllPages('/repos/o/r/pulls', { perPage: 2 });
      expect(all).toHaveLength(3);
      expect(all.map((x: any) => x.id)).toEqual([1, 2, 3]);
    });

    it('paginate yields nothing for empty first page', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse([]));

      const pages: any[][] = [];
      for await (const page of client.paginate('/repos/o/r/pulls')) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });
  });

  // =========================================================================
  // GitHubApiError
  // =========================================================================

  describe('GitHubApiError', () => {
    it('has correct name', () => {
      const err = new GitHubApiError('test', 404);
      expect(err.name).toBe('GitHubApiError');
    });

    it('isRateLimited is true for 403 with rate limit message', () => {
      const err = new GitHubApiError('API rate limit exceeded', 403);
      expect(err.isRateLimited).toBe(true);
    });

    it('isRateLimited is false for 403 without rate limit message', () => {
      const err = new GitHubApiError('Resource not accessible', 403);
      expect(err.isRateLimited).toBe(false);
    });

    it('isNotFound is true for 404', () => {
      expect(new GitHubApiError('Not found', 404).isNotFound).toBe(true);
      expect(new GitHubApiError('Not found', 403).isNotFound).toBe(false);
    });

    it('isUnauthorized is true for 401', () => {
      expect(new GitHubApiError('Bad creds', 401).isUnauthorized).toBe(true);
      expect(new GitHubApiError('Bad creds', 403).isUnauthorized).toBe(false);
    });
  });
});
