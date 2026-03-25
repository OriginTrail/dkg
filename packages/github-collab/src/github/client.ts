/**
 * GitHub REST API Client
 *
 * Uses native fetch() per architecture decision (no external client library).
 * Handles pagination, rate limiting, conditional requests (ETag), and error classification.
 */

const GITHUB_API = 'https://api.github.com';

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
}

export interface PaginationOptions {
  page?: number;
  perPage?: number;
}

export interface ListPullRequestsOptions extends PaginationOptions {
  state?: 'open' | 'closed' | 'all';
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
}

export interface ListIssuesOptions extends PaginationOptions {
  state?: 'open' | 'closed' | 'all';
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  since?: string;
  labels?: string;
}

export interface ListCommitsOptions extends PaginationOptions {
  sha?: string;
  since?: string;
  until?: string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response?: any,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }

  get isRateLimited(): boolean { return this.status === 403 && this.message.includes('rate limit'); }
  get isNotFound(): boolean { return this.status === 404; }
  get isUnauthorized(): boolean { return this.status === 401; }
}

export class GitHubClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private rateLimitInfo: RateLimitInfo | null = null;
  private static readonly ETAG_CACHE_MAX = 1000;
  private readonly etagCache = new Map<string, { etag: string; data: any }>();

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/$/, '');
  }

  getRateLimit(): RateLimitInfo | null {
    return this.rateLimitInfo;
  }

  // --- Repository ---

  async getRepository(owner: string, repo: string): Promise<any> {
    return this.get(`/repos/${owner}/${repo}`);
  }

  // --- Pull Requests ---

  async listPullRequests(owner: string, repo: string, options: ListPullRequestsOptions = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.state) params.set('state', options.state);
    if (options.sort) params.set('sort', options.sort);
    if (options.direction) params.set('direction', options.direction);
    params.set('per_page', String(options.perPage ?? 30));
    if (options.page) params.set('page', String(options.page));
    return this.get(`/repos/${owner}/${repo}/pulls?${params}`);
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<any> {
    return this.get(`/repos/${owner}/${repo}/pulls/${number}`);
  }

  async getPullRequestReviews(owner: string, repo: string, number: number): Promise<any[]> {
    return this.get(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
  }

  async getPullRequestFiles(owner: string, repo: string, number: number): Promise<any[]> {
    return this.get(`/repos/${owner}/${repo}/pulls/${number}/files`);
  }

  async getPullRequestComments(owner: string, repo: string, number: number): Promise<any[]> {
    return this.get(`/repos/${owner}/${repo}/pulls/${number}/comments`);
  }

  // --- Issues ---

  async listIssues(owner: string, repo: string, options: ListIssuesOptions = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.state) params.set('state', options.state);
    if (options.sort) params.set('sort', options.sort);
    if (options.direction) params.set('direction', options.direction);
    if (options.since) params.set('since', options.since);
    if (options.labels) params.set('labels', options.labels);
    params.set('per_page', String(options.perPage ?? 30));
    if (options.page) params.set('page', String(options.page));
    return this.get(`/repos/${owner}/${repo}/issues?${params}`);
  }

  async getIssue(owner: string, repo: string, number: number): Promise<any> {
    return this.get(`/repos/${owner}/${repo}/issues/${number}`);
  }

  async getIssueComments(owner: string, repo: string, number: number): Promise<any[]> {
    return this.get(`/repos/${owner}/${repo}/issues/${number}/comments`);
  }

  // --- Commits ---

  async listCommits(owner: string, repo: string, options: ListCommitsOptions = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (options.sha) params.set('sha', options.sha);
    if (options.since) params.set('since', options.since);
    if (options.until) params.set('until', options.until);
    params.set('per_page', String(options.perPage ?? 30));
    if (options.page) params.set('page', String(options.page));
    return this.get(`/repos/${owner}/${repo}/commits?${params}`);
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<any> {
    return this.get(`/repos/${owner}/${repo}/commits/${sha}`);
  }

  // --- Git Trees & Blobs ---

  async getTree(owner: string, repo: string, treeSha: string, recursive = true): Promise<any> {
    const params = recursive ? '?recursive=1' : '';
    return this.get(`/repos/${owner}/${repo}/git/trees/${treeSha}${params}`);
  }

  async getBlob(owner: string, repo: string, blobSha: string): Promise<{ content: string; encoding: string; size: number }> {
    return this.get(`/repos/${owner}/${repo}/git/blobs/${blobSha}`);
  }

  async getCommitSha(owner: string, repo: string, ref: string): Promise<{ commitSha: string; treeSha: string }> {
    const data = await this.get(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
    return { commitSha: data.sha, treeSha: data.commit.tree.sha };
  }

  // --- Branches ---

  async listBranches(owner: string, repo: string, options: PaginationOptions = {}): Promise<any[]> {
    const params = new URLSearchParams();
    params.set('per_page', String(options.perPage ?? 100));
    if (options.page) params.set('page', String(options.page));
    return this.get(`/repos/${owner}/${repo}/branches?${params}`);
  }

  // --- Token validation ---

  async validateToken(): Promise<{ valid: boolean; login?: string; scopes?: string[]; error?: string }> {
    try {
      const user = await this.get('/user');
      return { valid: true, login: user.login, scopes: this.lastScopes };
    } catch (err) {
      if (err instanceof GitHubApiError && err.isUnauthorized) {
        return { valid: false, error: 'Invalid token' };
      }
      // 403 = token valid but lacks user scope (common with fine-grained PATs)
      if (err instanceof GitHubApiError && err.status === 403) {
        try {
          const rateLimit = await this.get('/rate_limit');
          const isAuthenticated = rateLimit?.rate?.limit > 60;
          if (isAuthenticated) {
            return { valid: true, login: '(fine-grained PAT)', scopes: this.lastScopes };
          }
        } catch { /* fall through */ }
        return { valid: false, error: 'Token lacks required permissions' };
      }
      throw err;
    }
  }

  // --- Pagination ---

  async *paginate<T = any>(path: string, options: PaginationOptions = {}): AsyncGenerator<T[]> {
    let page = options.page ?? 1;
    const perPage = options.perPage ?? 100;

    while (true) {
      const sep = path.includes('?') ? '&' : '?';
      const url = `${path}${sep}per_page=${perPage}&page=${page}`;
      const response = await this.request('GET', url);
      const data: T[] = await response.json();

      if (data.length > 0) yield data;
      if (data.length < perPage) break;

      const linkHeader = response.headers.get('link');
      if (!linkHeader || !linkHeader.includes('rel="next"')) break;

      page++;
    }
  }

  async fetchAllPages<T = any>(path: string, options?: PaginationOptions): Promise<T[]> {
    const results: T[] = [];
    for await (const page of this.paginate<T>(path, options)) {
      results.push(...page);
    }
    return results;
  }

  // --- Internal ---

  private lastScopes?: string[];

  private async get(path: string): Promise<any> {
    const response = await this.request('GET', path);
    return response.json();
  }

  private async request(method: string, path: string, body?: any): Promise<Response> {
    await this.checkRateLimit();

    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    // Conditional request with ETag
    const cached = this.etagCache.get(url);
    if (cached && method === 'GET') {
      headers['If-None-Match'] = cached.etag;
    }

    const init: RequestInit = { method, headers };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    // Update rate limit info
    this.updateRateLimit(response.headers);

    // Store scopes for validateToken
    const scopesHeader = response.headers.get('x-oauth-scopes');
    if (scopesHeader) {
      this.lastScopes = scopesHeader.split(',').map(s => s.trim()).filter(Boolean);
    }

    // Handle 304 Not Modified
    if (response.status === 304 && cached) {
      return new Response(JSON.stringify(cached.data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Cache ETag (with LRU eviction at max size)
    const etag = response.headers.get('etag');
    if (etag && response.ok && method === 'GET') {
      const cloned = response.clone();
      cloned.json().then(data => {
        if (this.etagCache.size >= GitHubClient.ETAG_CACHE_MAX) {
          // Delete the oldest entry (first key in insertion-order Map)
          const oldest = this.etagCache.keys().next().value;
          if (oldest !== undefined) this.etagCache.delete(oldest);
        }
        this.etagCache.set(url, { etag, data });
      }).catch(() => {});
    }

    if (!response.ok) {
      let errorBody: any;
      try { errorBody = await response.json(); } catch { errorBody = undefined; }

      if (response.status === 403) {
        const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
        if (rateLimitRemaining === '0') {
          const resetTime = Number(response.headers.get('x-ratelimit-reset') ?? 0);
          const waitMs = Math.max(0, resetTime * 1000 - Date.now());
          throw new GitHubApiError(
            `GitHub API rate limit exceeded. Resets in ${Math.ceil(waitMs / 1000)}s.`,
            403,
            errorBody,
          );
        }
      }

      throw new GitHubApiError(
        errorBody?.message ?? `GitHub API error: ${response.status} ${response.statusText}`,
        response.status,
        errorBody,
      );
    }

    return response;
  }

  private updateRateLimit(headers: Headers): void {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const used = headers.get('x-ratelimit-used');

    if (limit && remaining && reset) {
      this.rateLimitInfo = {
        limit: Number(limit),
        remaining: Number(remaining),
        reset: Number(reset),
        used: Number(used ?? 0),
      };
    }
  }

  private async checkRateLimit(): Promise<void> {
    if (!this.rateLimitInfo) return;
    if (this.rateLimitInfo.remaining > 10) return;

    if (this.rateLimitInfo.remaining <= 0) {
      const waitMs = Math.max(0, this.rateLimitInfo.reset * 1000 - Date.now());
      if (waitMs > 0 && waitMs < 120_000) {
        await new Promise(resolve => setTimeout(resolve, waitMs + 1000));
      } else if (waitMs >= 120_000) {
        throw new GitHubApiError(
          `Rate limit exhausted. Resets in ${Math.ceil(waitMs / 1000)}s.`,
          429,
        );
      }
    }
  }
}
