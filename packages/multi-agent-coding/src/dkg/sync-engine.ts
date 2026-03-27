/**
 * GitHub Sync Engine
 *
 * Handles webhook processing, polling, and data ingestion.
 * Transforms GitHub events to RDF and routes to the coordinator.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GitHubClient } from '../github/client.js';
import { CodeSync } from '../github/code-sync.js';
import {
  transformRepository,
  transformPullRequest,
  transformPullRequestFiles,
  transformReview,
  transformReviewComment,
  transformIssue,
  transformIssueComment,
  transformCommit,
  transformBranch,
} from '../rdf/transformer.js';
import type { Quad } from '../rdf/uri.js';

export interface RepoSyncConfig {
  owner: string;
  repo: string;
  githubToken?: string;
  webhookSecret?: string;
  pollIntervalMs: number;
  syncScope: SyncScope[];
  paranetId: string;
}

export type SyncScope = 'pull_requests' | 'issues' | 'reviews' | 'commits' | 'comments' | 'code_structure';

export interface SyncJob {
  jobId: string;
  repoKey: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: Record<string, { total: number; synced: number }>;
  startedAt: string;
  completedAt?: string;
  errors: string[];
}

export interface WebhookResult {
  ok: boolean;
  event: string;
  action?: string;
  quadsWritten: number;
}

type QuadWriter = (paranetId: string, quads: Quad[]) => Promise<void>;

export class SyncEngine {
  private readonly clients = new Map<string, GitHubClient>();
  private readonly configs = new Map<string, RepoSyncConfig>();
  private readonly pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly processedDeliveries = new Set<string>();
  private readonly syncJobs = new Map<string, SyncJob>();
  private readonly highWaterMarks = new Map<string, string>();
  private readonly writeQuads: QuadWriter;
  private readonly onSyncComplete?: (repoKey: string, scope: string[], quadsWritten: number) => void;
  private jobCounter = 0;

  constructor(
    writeQuads: QuadWriter,
    onSyncComplete?: (repoKey: string, scope: string[], quadsWritten: number) => void,
  ) {
    this.writeQuads = writeQuads;
    this.onSyncComplete = onSyncComplete;
  }

  /**
   * Write quads in batches to avoid workspace message size limits (512KB).
   * Splits into chunks of ~200 quads each (~50-100KB per batch).
   */
  private async writeQuadsBatched(paranetId: string, quads: Quad[]): Promise<void> {
    const BATCH_SIZE = 200;
    for (let i = 0; i < quads.length; i += BATCH_SIZE) {
      const batch = quads.slice(i, i + BATCH_SIZE);
      await this.writeQuads(paranetId, batch);
    }
  }

  // --- Configuration ---

  addRepo(config: RepoSyncConfig): void {
    const key = `${config.owner}/${config.repo}`;
    this.configs.set(key, config);
    this.clients.set(key, new GitHubClient({ token: config.githubToken }));
  }

  removeRepo(owner: string, repo: string): void {
    const key = `${owner}/${repo}`;
    this.configs.delete(key);
    this.clients.delete(key);
    this.stopPolling(key);
  }

  getConfig(owner: string, repo: string): RepoSyncConfig | undefined {
    return this.configs.get(`${owner}/${repo}`);
  }

  getConfiguredRepos(): string[] {
    return [...this.configs.keys()];
  }

  getClient(owner: string, repo: string): GitHubClient | undefined {
    return this.clients.get(`${owner}/${repo}`);
  }

  // --- Webhook Processing ---

  validateWebhook(body: Buffer, signature: string | undefined, secret?: string): boolean {
    if (!secret) return true;
    if (!signature) return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  async processWebhook(
    event: string,
    action: string | undefined,
    payload: any,
    deliveryId?: string,
  ): Promise<WebhookResult> {
    // Deduplication
    if (deliveryId) {
      if (this.processedDeliveries.has(deliveryId)) {
        return { ok: true, event, action, quadsWritten: 0 };
      }
      this.processedDeliveries.add(deliveryId);
      // Keep set bounded
      if (this.processedDeliveries.size > 10_000) {
        const iter = this.processedDeliveries.values();
        for (let i = 0; i < 5_000; i++) {
          const v = iter.next();
          if (v.done) break;
          this.processedDeliveries.delete(v.value);
        }
      }
    }

    const repoData = payload.repository;
    if (!repoData?.owner?.login || !repoData?.name) {
      return { ok: false, event, action, quadsWritten: 0 };
    }

    const owner = repoData.owner.login;
    const repo = repoData.name;
    const config = this.configs.get(`${owner}/${repo}`);
    if (!config) {
      return { ok: false, event, action, quadsWritten: 0 };
    }

    // Map webhook event types to syncScope values and skip if not in scope
    const eventScopeMap: Record<string, SyncScope> = {
      pull_request: 'pull_requests',
      pull_request_review: 'reviews',
      pull_request_review_comment: 'comments',
      issues: 'issues',
      issue_comment: 'comments',
      push: 'commits',
    };
    const requiredScope = eventScopeMap[event];
    if (requiredScope && !config.syncScope.includes(requiredScope)) {
      return { ok: true, event, action, quadsWritten: 0 };
    }

    const graph = `did:dkg:paranet:${config.paranetId}`;
    let quads: Quad[] = [];

    switch (event) {
      case 'pull_request':
        quads = transformPullRequest(payload.pull_request, owner, repo, graph);
        break;

      case 'pull_request_review':
        if (payload.review && payload.pull_request?.number) {
          quads = transformReview(payload.review, owner, repo, payload.pull_request.number, graph);
        }
        break;

      case 'pull_request_review_comment':
        if (payload.comment && payload.pull_request?.number) {
          quads = transformReviewComment(payload.comment, owner, repo, payload.pull_request.number, graph);
        }
        break;

      case 'issues':
        quads = transformIssue(payload.issue, owner, repo, graph);
        break;

      case 'issue_comment':
        if (payload.comment && payload.issue?.number) {
          quads = transformIssueComment(payload.comment, owner, repo, payload.issue.number, graph);
        }
        break;

      case 'push':
        if (Array.isArray(payload.commits)) {
          for (const c of payload.commits) {
            quads.push(...transformCommit({ sha: c.id, commit: c, html_url: c.url }, owner, repo, graph));
          }
        }
        break;

      default:
        return { ok: true, event, action, quadsWritten: 0 };
    }

    if (quads.length > 0) {
      await this.writeQuads(config.paranetId, quads);
    }

    return { ok: true, event, action, quadsWritten: quads.length };
  }

  // --- Polling ---

  startPolling(repoKey: string): void {
    const config = this.configs.get(repoKey);
    if (!config || this.pollTimers.has(repoKey)) return;

    const timer = setInterval(() => {
      this.pollRepo(repoKey).catch(err => {
        console.error(`[github-collab] Poll error for ${repoKey}:`, err.message);
      });
    }, config.pollIntervalMs);

    this.pollTimers.set(repoKey, timer);
  }

  stopPolling(repoKey: string): void {
    const timer = this.pollTimers.get(repoKey);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(repoKey);
    }
  }

  /**
   * Poll for incremental updates. Only PRs and issues are polled; reviews and
   * commits are fetched as part of PR syncing during full sync, and code_structure
   * doesn't change between full syncs.
   */
  private async pollRepo(repoKey: string): Promise<void> {
    const config = this.configs.get(repoKey);
    const client = this.clients.get(repoKey);
    if (!config || !client) return;

    const graph = `did:dkg:paranet:${config.paranetId}`;
    const { owner, repo } = config;
    let totalQuads = 0;
    const scopes: string[] = [];

    if (config.syncScope.includes('pull_requests')) {
      scopes.push('pull_requests');
      const since = this.highWaterMarks.get(`${repoKey}:prs`);
      const prs = await client.fetchAllPages(`/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc`);
      const quads: Quad[] = [];
      for (const pr of prs) {
        if (since && pr.updated_at && pr.updated_at <= since) break;
        quads.push(...transformPullRequest(pr, owner, repo, graph));
      }
      if (quads.length > 0) {
        await this.writeQuads(config.paranetId, quads);
        totalQuads += quads.length;
      }
      if (prs.length > 0 && prs[0].updated_at) {
        this.highWaterMarks.set(`${repoKey}:prs`, prs[0].updated_at);
      }
    }

    if (config.syncScope.includes('issues')) {
      scopes.push('issues');
      const since = this.highWaterMarks.get(`${repoKey}:issues`);
      const sinceParam = since ? `&since=${since}` : '';
      const allIssues = await client.fetchAllPages(`/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc${sinceParam}`);
      const issues = allIssues.filter((issue: any) => !issue.pull_request);
      const quads: Quad[] = [];
      for (const issue of issues) {
        quads.push(...transformIssue(issue, owner, repo, graph));
      }
      if (quads.length > 0) {
        await this.writeQuads(config.paranetId, quads);
        totalQuads += quads.length;
      }
      if (issues.length > 0 && issues[0].updated_at) {
        this.highWaterMarks.set(`${repoKey}:issues`, issues[0].updated_at);
      }
    }

    if (totalQuads > 0) {
      this.onSyncComplete?.(repoKey, scopes, totalQuads);
    }
  }

  // --- Full Sync ---

  async startFullSync(
    owner: string,
    repo: string,
    scope?: SyncScope[],
    since?: string,
  ): Promise<SyncJob> {
    const repoKey = `${owner}/${repo}`;
    const config = this.configs.get(repoKey);
    const client = this.clients.get(repoKey);
    if (!config || !client) {
      throw new Error(`Repository ${repoKey} is not configured`);
    }

    const jobId = `sync-${++this.jobCounter}`;
    const syncScopes = scope ?? config.syncScope;
    const job: SyncJob = {
      jobId,
      repoKey,
      status: 'running',
      progress: {},
      startedAt: new Date().toISOString(),
      errors: [],
    };
    this.syncJobs.set(jobId, job);

    // Run sync in background
    this.runFullSync(job, config, client, syncScopes, since).catch(err => {
      job.status = 'failed';
      job.errors.push(err.message);
    });

    return job;
  }

  private async runFullSync(
    job: SyncJob,
    config: RepoSyncConfig,
    client: GitHubClient,
    scopes: SyncScope[],
    since?: string,
  ): Promise<void> {
    const { owner, repo, paranetId } = config;
    const repoKey = `${owner}/${repo}`;
    // Use the paranet data graph URI — the workspace handler manages graph scoping internally.
    // Do NOT append /_workspace here; the DKG publisher validates quads against the paranet data graph.
    const graph = `did:dkg:paranet:${paranetId}`;
    let totalQuadsWritten = 0;

    try {
      // Repository metadata
      const repoData = await client.getRepository(owner, repo);
      const repoQuads = transformRepository(repoData, graph);
      if (repoQuads.length > 0) {
        await this.writeQuads(paranetId, repoQuads);
        totalQuadsWritten += repoQuads.length;
      }

      // Branches
      const branches = await client.listBranches(owner, repo);
      const branchQuads: Quad[] = [];
      for (const b of branches) {
        branchQuads.push(...transformBranch(b, owner, repo, graph));
      }
      if (branchQuads.length > 0) {
        await this.writeQuads(paranetId, branchQuads);
        totalQuadsWritten += branchQuads.length;
      }

      // Pull Requests
      if (scopes.includes('pull_requests')) {
        job.progress.pullRequests = { total: 0, synced: 0 };
        const prs = await client.fetchAllPages(`/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc`);
        job.progress.pullRequests.total = prs.length;

        for (const pr of prs) {
          if (since && pr.updated_at && pr.updated_at < since) continue;
          const quads = transformPullRequest(pr, owner, repo, graph);

          // Fetch files for each PR
          if (scopes.includes('reviews') || scopes.includes('commits')) {
            try {
              const files = await client.getPullRequestFiles(owner, repo, pr.number);
              quads.push(...transformPullRequestFiles(files, owner, repo, pr.number, graph));
            } catch { /* skip on error */ }
          }

          // Fetch reviews
          if (scopes.includes('reviews')) {
            try {
              const reviews = await client.getPullRequestReviews(owner, repo, pr.number);
              for (const review of reviews) {
                quads.push(...transformReview(review, owner, repo, pr.number, graph));
              }
            } catch { /* skip on error */ }
          }

          // TODO: PR review comments (inline code comments) are not yet synced
          // during full sync. Fetching them requires a per-PR API call to
          // GET /repos/{owner}/{repo}/pulls/{number}/comments which is expensive
          // at scale. Add when incremental sync makes this feasible.

          if (quads.length > 0) {
            await this.writeQuads(paranetId, quads);
            totalQuadsWritten += quads.length;
          }
          job.progress.pullRequests.synced++;
        }
      }

      // Issues
      if (scopes.includes('issues')) {
        job.progress.issues = { total: 0, synced: 0 };
        const allIssues = await client.fetchAllPages(`/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc`);
        const issues = allIssues.filter((i: any) => !i.pull_request);
        job.progress.issues.total = issues.length;

        for (const issue of issues) {
          if (since && issue.updated_at && issue.updated_at < since) continue;
          const quads = transformIssue(issue, owner, repo, graph);

          if (scopes.includes('comments') && issue.comments > 0) {
            try {
              const comments = await client.getIssueComments(owner, repo, issue.number);
              for (const comment of comments) {
                quads.push(...transformIssueComment(comment, owner, repo, issue.number, graph));
              }
            } catch { /* skip on error */ }
          }

          if (quads.length > 0) {
            await this.writeQuads(paranetId, quads);
            totalQuadsWritten += quads.length;
          }
          job.progress.issues.synced++;
        }
      }

      // Commits
      if (scopes.includes('commits')) {
        job.progress.commits = { total: 0, synced: 0 };
        const commits = await client.fetchAllPages(
          `/repos/${owner}/${repo}/commits?per_page=100${since ? `&since=${since}` : ''}`,
        );
        job.progress.commits.total = commits.length;

        for (const commit of commits) {
          const quads = transformCommit(commit, owner, repo, graph);
          if (quads.length > 0) {
            await this.writeQuads(paranetId, quads);
            totalQuadsWritten += quads.length;
          }
          job.progress.commits.synced++;
        }
      }

      // Code Structure (Phase A: tree, Phase B: parse, Phase C: relationships)
      if (scopes.includes('code_structure')) {
        job.progress.codeStructure = { total: 0, synced: 0 };
        const codeSync = new CodeSync(client);
        const defaultBranch = (await client.getRepository(owner, repo)).default_branch ?? 'main';

        // Phase A: File tree
        const treeResult = await codeSync.syncFileTree(owner, repo, defaultBranch, graph);
        job.progress.codeStructure.total = treeResult.fileCount;
        if (treeResult.quads.length > 0) {
          await this.writeQuadsBatched(paranetId, treeResult.quads);
          totalQuadsWritten += treeResult.quads.length;
        }
        job.progress.codeStructure.synced = treeResult.fileCount;

        // Phase B+C: Parse code entities and extract relationships
        job.progress.codeEntities = { total: 0, synced: 0 };
        try {
          const entityResult = await codeSync.syncCodeEntities(
            owner, repo, defaultBranch, graph, {},
            (progress) => {
              if (progress.phase === 'parsing') {
                job.progress.codeEntities.total = progress.total;
                job.progress.codeEntities.synced = progress.current;
              }
            },
            treeResult.treeSha, // reuse tree SHA from Phase A to avoid duplicate API call
          );
          job.progress.codeEntities.total = entityResult.parsedFiles;
          job.progress.codeEntities.synced = entityResult.parsedFiles;
          if (entityResult.quads.length > 0) {
            await this.writeQuadsBatched(paranetId, entityResult.quads);
            totalQuadsWritten += entityResult.quads.length;
          }
        } catch (err: any) {
          // Phase B+C failure should not fail the whole sync
          job.errors.push(`Code parsing: ${err.message}`);
        }
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      this.onSyncComplete?.(repoKey, scopes, totalQuadsWritten);
    } catch (err: any) {
      job.status = 'failed';
      job.errors.push(err.message);
    }
  }

  getSyncJob(jobId: string): SyncJob | undefined {
    return this.syncJobs.get(jobId);
  }

  getSyncJobForRepo(repoKey: string): SyncJob | undefined {
    // Return most recent job for this repo (any status — so UI can show errors)
    let latest: SyncJob | undefined;
    for (const job of this.syncJobs.values()) {
      if (job.repoKey === repoKey) {
        if (!latest || job.startedAt > latest.startedAt) {
          latest = job;
        }
      }
    }
    return latest;
  }

  // --- Cleanup ---

  destroy(): void {
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
  }
}
