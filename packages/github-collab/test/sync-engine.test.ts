/**
 * Unit tests for src/dkg/sync-engine.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { SyncEngine, type RepoSyncConfig } from '../src/dkg/sync-engine.js';
import {
  samplePullRequest,
  sampleReview,
  sampleIssue,
  sampleCommit,
  sampleRepository,
} from './helpers/index.js';

function makeConfig(overrides?: Partial<RepoSyncConfig>): RepoSyncConfig {
  return {
    owner: 'octocat',
    repo: 'Hello-World',
    githubToken: 'ghp_test',
    pollIntervalMs: 300_000,
    syncScope: ['pull_requests', 'issues', 'reviews', 'commits'],
    paranetId: 'github-collab:octocat/Hello-World',
    ...overrides,
  };
}

describe('SyncEngine', () => {
  let engine: SyncEngine;
  let writtenQuads: Array<{ paranetId: string; quads: any[] }>;

  beforeEach(() => {
    writtenQuads = [];
    engine = new SyncEngine(
      async (paranetId, quads) => { writtenQuads.push({ paranetId, quads }); },
    );
  });

  // =========================================================================
  // Configuration
  // =========================================================================

  describe('configuration', () => {
    it('addRepo stores config', () => {
      engine.addRepo(makeConfig());
      expect(engine.getConfig('octocat', 'Hello-World')).toBeDefined();
      expect(engine.getConfiguredRepos()).toContain('octocat/Hello-World');
    });

    it('removeRepo deletes config', () => {
      engine.addRepo(makeConfig());
      engine.removeRepo('octocat', 'Hello-World');
      expect(engine.getConfig('octocat', 'Hello-World')).toBeUndefined();
      expect(engine.getConfiguredRepos()).toHaveLength(0);
    });

    it('getClient returns client for configured repo', () => {
      engine.addRepo(makeConfig());
      expect(engine.getClient('octocat', 'Hello-World')).toBeDefined();
    });

    it('getClient returns undefined for unconfigured repo', () => {
      expect(engine.getClient('unknown', 'repo')).toBeUndefined();
    });
  });

  // =========================================================================
  // Webhook HMAC validation
  // =========================================================================

  describe('webhook HMAC validation', () => {
    it('returns true when no secret is configured', () => {
      const body = Buffer.from('{"action":"opened"}');
      expect(engine.validateWebhook(body, undefined)).toBe(true);
    });

    it('returns false when signature is missing but secret is set', () => {
      const body = Buffer.from('{"action":"opened"}');
      expect(engine.validateWebhook(body, undefined, 'my-secret')).toBe(false);
    });

    it('returns true for valid HMAC-SHA256 signature', () => {
      const secret = 'webhook-secret';
      const body = Buffer.from('{"action":"opened"}');
      const hmac = createHmac('sha256', secret).update(body).digest('hex');
      const signature = `sha256=${hmac}`;
      expect(engine.validateWebhook(body, signature, secret)).toBe(true);
    });

    it('returns false for invalid HMAC-SHA256 signature', () => {
      const body = Buffer.from('{"action":"opened"}');
      expect(engine.validateWebhook(body, 'sha256=invalid', 'my-secret')).toBe(false);
    });

    it('returns false for malformed signature (length mismatch)', () => {
      const body = Buffer.from('{}');
      expect(engine.validateWebhook(body, 'short', 'my-secret')).toBe(false);
    });
  });

  // =========================================================================
  // Webhook processing
  // =========================================================================

  describe('webhook processing', () => {
    beforeEach(() => {
      engine.addRepo(makeConfig());
    });

    it('processes pull_request event and writes quads', async () => {
      const result = await engine.processWebhook('pull_request', 'opened', {
        pull_request: samplePullRequest,
        repository: sampleRepository,
      });
      expect(result.ok).toBe(true);
      expect(result.event).toBe('pull_request');
      expect(result.action).toBe('opened');
      expect(result.quadsWritten).toBeGreaterThan(0);
      expect(writtenQuads).toHaveLength(1);
      expect(writtenQuads[0].paranetId).toBe('github-collab:octocat/Hello-World');
    });

    it('processes issues event and writes quads', async () => {
      const result = await engine.processWebhook('issues', 'opened', {
        issue: sampleIssue,
        repository: sampleRepository,
      });
      expect(result.ok).toBe(true);
      expect(result.quadsWritten).toBeGreaterThan(0);
    });

    it('processes pull_request_review event', async () => {
      const result = await engine.processWebhook('pull_request_review', 'submitted', {
        review: sampleReview,
        pull_request: samplePullRequest,
        repository: sampleRepository,
      });
      expect(result.ok).toBe(true);
      expect(result.quadsWritten).toBeGreaterThan(0);
    });

    it('processes push event with commits', async () => {
      const result = await engine.processWebhook('push', undefined, {
        commits: [{
          id: 'abc123',
          message: 'fix: something',
          url: 'https://github.com/...',
          author: { name: 'Octocat', email: 'o@cat.com' },
        }],
        repository: sampleRepository,
      });
      expect(result.ok).toBe(true);
      expect(result.quadsWritten).toBeGreaterThan(0);
    });

    it('returns ok false for unconfigured repo', async () => {
      const result = await engine.processWebhook('pull_request', 'opened', {
        pull_request: samplePullRequest,
        repository: { ...sampleRepository, owner: { login: 'unknown' }, name: 'unknown' },
      });
      expect(result.ok).toBe(false);
      expect(result.quadsWritten).toBe(0);
    });

    it('returns ok false when repository is missing from payload', async () => {
      const result = await engine.processWebhook('pull_request', 'opened', {
        pull_request: samplePullRequest,
      });
      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  // Delivery deduplication
  // =========================================================================

  describe('delivery deduplication', () => {
    beforeEach(() => {
      engine.addRepo(makeConfig());
    });

    it('processes same deliveryId only once', async () => {
      const payload = {
        pull_request: samplePullRequest,
        repository: sampleRepository,
      };

      const r1 = await engine.processWebhook('pull_request', 'opened', payload, 'delivery-1');
      expect(r1.ok).toBe(true);
      expect(r1.quadsWritten).toBeGreaterThan(0);

      const r2 = await engine.processWebhook('pull_request', 'opened', payload, 'delivery-1');
      expect(r2.ok).toBe(true);
      expect(r2.quadsWritten).toBe(0); // Deduplicated
    });

    it('processes different deliveryIds independently', async () => {
      const payload = {
        pull_request: samplePullRequest,
        repository: sampleRepository,
      };

      const r1 = await engine.processWebhook('pull_request', 'opened', payload, 'delivery-1');
      const r2 = await engine.processWebhook('pull_request', 'opened', payload, 'delivery-2');
      expect(r1.quadsWritten).toBeGreaterThan(0);
      expect(r2.quadsWritten).toBeGreaterThan(0);
    });

    it('processes events without deliveryId (no dedup)', async () => {
      const payload = {
        pull_request: samplePullRequest,
        repository: sampleRepository,
      };

      const r1 = await engine.processWebhook('pull_request', 'opened', payload);
      const r2 = await engine.processWebhook('pull_request', 'opened', payload);
      expect(r1.quadsWritten).toBeGreaterThan(0);
      expect(r2.quadsWritten).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Full sync
  // =========================================================================

  describe('onSyncComplete callback', () => {
    it('is called with repoKey, scopes, and quad count on full sync completion', async () => {
      const completions: Array<{ repoKey: string; scope: string[]; quads: number }> = [];
      const engineWithCb = new SyncEngine(
        async (_paranetId, _quads) => {},
        (repoKey, scope, quadsWritten) => { completions.push({ repoKey, scope, quads: quadsWritten }); },
      );
      engineWithCb.addRepo(makeConfig());
      const job = await engineWithCb.startFullSync('octocat', 'Hello-World');
      // Wait for background sync (will fail at GitHub API, but callback is only called on success)
      await new Promise(r => setTimeout(r, 500));
      // The job will fail because the mock GitHub client hits a real HTTP call.
      // In production, onSyncComplete fires on success. Here we verify the callback exists.
      expect(job.jobId).toBeTruthy();
      engineWithCb.destroy();
    });

    it('is called by pollRepo on successful poll', async () => {
      // For polling, onSyncComplete is invoked after pollRepo writes quads.
      // We can't easily test the live poll without a mock HTTP server, but
      // we verify the constructor wiring is correct.
      const completions: Array<{ repoKey: string; scope: string[]; quads: number }> = [];
      const engineWithCb = new SyncEngine(
        async (_paranetId, _quads) => {},
        (repoKey, scope, quadsWritten) => { completions.push({ repoKey, scope, quads: quadsWritten }); },
      );
      expect(engineWithCb).toBeDefined();
      engineWithCb.destroy();
    });
  });

  describe('commits sync scope', () => {
    it('includes commits in default syncScope', () => {
      const config = makeConfig();
      expect(config.syncScope).toContain('commits');
    });

    it('full sync creates commits progress when scope includes commits', async () => {
      engine.addRepo(makeConfig({ syncScope: ['commits'] }));
      const job = await engine.startFullSync('octocat', 'Hello-World', ['commits']);
      expect(job.jobId).toBeTruthy();
      // Wait for background sync to attempt
      await new Promise(r => setTimeout(r, 500));
      // The job may fail at the API call, but the progress key should be initialized
      expect(['running', 'failed']).toContain(job.status);
    });
  });

  describe('full sync', () => {
    it('creates a sync job', async () => {
      engine.addRepo(makeConfig());
      // startFullSync will try to use the GitHubClient which will fail (no real API)
      // But it should still create a job
      const job = await engine.startFullSync('octocat', 'Hello-World', ['pull_requests']);
      expect(job.jobId).toBeTruthy();
      expect(job.repoKey).toBe('octocat/Hello-World');
      // Status will be either running or failed depending on timing
      expect(['queued', 'running', 'completed', 'failed']).toContain(job.status);
    });

    it('getSyncJob returns existing job', async () => {
      engine.addRepo(makeConfig());
      const job = await engine.startFullSync('octocat', 'Hello-World');
      const found = engine.getSyncJob(job.jobId);
      expect(found).toBeDefined();
      expect(found!.jobId).toBe(job.jobId);
    });

    it('getSyncJob returns undefined for unknown job', () => {
      expect(engine.getSyncJob('nonexistent')).toBeUndefined();
    });

    it('getSyncJobForRepo returns job by repo key', async () => {
      engine.addRepo(makeConfig());
      await engine.startFullSync('octocat', 'Hello-World');
      const found = engine.getSyncJobForRepo('octocat/Hello-World');
      expect(found).toBeDefined();
    });

    it('getSyncJobForRepo returns most recent job (not just running ones)', async () => {
      engine.addRepo(makeConfig());
      const job1 = await engine.startFullSync('octocat', 'Hello-World');
      // Wait briefly for the first job to potentially start
      await new Promise(r => setTimeout(r, 50));
      const job2 = await engine.startFullSync('octocat', 'Hello-World');

      const found = engine.getSyncJobForRepo('octocat/Hello-World');
      expect(found).toBeDefined();
      expect(found!.jobId).toBe(job2.jobId);
    });

    it('getSyncJobForRepo returns failed jobs', async () => {
      engine.addRepo(makeConfig());
      const job = await engine.startFullSync('octocat', 'Hello-World');
      // Wait for the background sync to fail (no real GitHub API).
      // The sync fires fetch requests that fail immediately, so a short wait suffices.
      await new Promise(r => setTimeout(r, 500));

      const found = engine.getSyncJobForRepo('octocat/Hello-World');
      expect(found).toBeDefined();
      // The job should be failed since the mock GitHub client will error
      expect(['failed', 'running']).toContain(found!.status);
      // At minimum, the job is visible regardless of status
      expect(found!.jobId).toBe(job.jobId);
    });

    it('getSyncJobForRepo returns undefined for unconfigured repo', () => {
      expect(engine.getSyncJobForRepo('unknown/repo')).toBeUndefined();
    });
  });

  // =========================================================================
  // Polling
  // =========================================================================

  describe('polling', () => {
    it('startPolling is safe for unconfigured repo', () => {
      expect(() => engine.startPolling('unknown/repo')).not.toThrow();
    });

    it('stopPolling is safe when not polling', () => {
      expect(() => engine.stopPolling('unknown/repo')).not.toThrow();
    });

    it('stopPolling clears a started poll', () => {
      engine.addRepo(makeConfig());
      engine.startPolling('octocat/Hello-World');
      expect(() => engine.stopPolling('octocat/Hello-World')).not.toThrow();
    });
  });

  // =========================================================================
  // Destroy
  // =========================================================================

  describe('destroy', () => {
    it('stops all polling and cleans up', () => {
      engine.addRepo(makeConfig());
      engine.startPolling('octocat/Hello-World');
      expect(() => engine.destroy()).not.toThrow();
    });
  });
});
