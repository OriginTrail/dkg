/**
 * Unit tests for src/api/handler.ts
 *
 * Uses makeMockAgent + createMockReq/createMockRes from test helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import createHandler from '../src/api/handler.js';
import type { AppRequestHandler } from '../src/api/handler.js';
import { makeMockAgent, createMockReq, createMockRes, type MockAgent } from './helpers/index.js';

const PREFIX = '/api/apps/github-collab';

/** Helper to invoke the handler with a GET request. */
async function get(handler: AppRequestHandler, subpath: string, query = ''): Promise<{ status: number; body: any }> {
  const fullUrl = `${PREFIX}${subpath}${query ? '?' + query : ''}`;
  const req = createMockReq('GET', fullUrl);
  const mock = createMockRes();
  const url = new URL(fullUrl, 'http://localhost');
  await handler(req, mock.res, url);
  return { status: mock.status, body: mock.body ? JSON.parse(mock.body) : null };
}

/** Helper to invoke the handler with a POST request. */
async function post(
  handler: AppRequestHandler,
  subpath: string,
  body: any,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const fullUrl = `${PREFIX}${subpath}`;
  const req = createMockReq('POST', fullUrl, body, headers);
  const mock = createMockRes();
  const url = new URL(fullUrl, 'http://localhost');
  await handler(req, mock.res, url);
  return { status: mock.status, body: mock.body ? JSON.parse(mock.body) : null };
}

/** Helper to invoke handler with DELETE request. */
async function del(handler: AppRequestHandler, subpath: string, body: any): Promise<{ status: number; body: any }> {
  const fullUrl = `${PREFIX}${subpath}`;
  const req = createMockReq('DELETE', fullUrl, body);
  const mock = createMockRes();
  const url = new URL(fullUrl, 'http://localhost');
  await handler(req, mock.res, url);
  return { status: mock.status, body: mock.body ? JSON.parse(mock.body) : null };
}

describe('GitHub Collab API handler', () => {
  let agent: MockAgent;
  let handler: AppRequestHandler & { destroy: () => void };

  beforeEach(() => {
    agent = makeMockAgent();
    handler = createHandler(agent, { name: 'test-node', configPath: null });
  });

  afterEach(() => {
    handler.destroy();
  });

  // =========================================================================
  // Route matching
  // =========================================================================

  describe('route matching', () => {
    it('returns false for non-matching routes', async () => {
      const req = createMockReq('GET', '/api/apps/other-app/info');
      const mock = createMockRes();
      const url = new URL(req.url!, 'http://localhost');
      const handled = await handler(req, mock.res, url);
      expect(handled).toBe(false);
    });

    it('returns true for matching routes', async () => {
      const req = createMockReq('GET', `${PREFIX}/info`);
      const mock = createMockRes();
      const url = new URL(req.url!, 'http://localhost');
      const handled = await handler(req, mock.res, url);
      expect(handled).toBe(true);
    });

    it('returns 404 for unknown subpaths', async () => {
      const result = await get(handler, '/nonexistent');
      expect(result.status).toBe(404);
      expect(result.body.error).toBe('Not found');
    });
  });

  // =========================================================================
  // CORS
  // =========================================================================

  describe('CORS', () => {
    it('handles OPTIONS preflight', async () => {
      const req = createMockReq('OPTIONS', `${PREFIX}/info`);
      const mock = createMockRes();
      const url = new URL(req.url!, 'http://localhost');
      const handled = await handler(req, mock.res, url);
      expect(handled).toBe(true);
      expect(mock.status).toBe(204);
    });

    it('includes Access-Control-Allow-Origin in JSON responses', async () => {
      const req = createMockReq('GET', `${PREFIX}/info`);
      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      } as any;
      const url = new URL(req.url!, 'http://localhost');
      await handler(req, res, url);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Access-Control-Allow-Origin': '*',
      }));
    });
  });

  // =========================================================================
  // GET /info
  // =========================================================================

  describe('GET /info', () => {
    it('returns app info with DKG enabled', async () => {
      const result = await get(handler, '/info');
      expect(result.status).toBe(200);
      expect(result.body.id).toBe('github-collab');
      expect(result.body.label).toBe('GitHub Collaboration');
      expect(result.body.version).toBe('0.1.0');
      expect(result.body.dkgEnabled).toBe(true);
      expect(result.body.peerId).toBe('test-peer-1');
      expect(result.body.nodeName).toBe('test-node');
    });

    it('returns dkgEnabled false when no agent', async () => {
      const noAgentHandler = createHandler();
      const result = await get(noAgentHandler, '/info');
      expect(result.status).toBe(200);
      expect(result.body.dkgEnabled).toBe(false);
      expect(result.body.peerId).toBeNull();
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // GET /status
  // =========================================================================

  describe('GET /status', () => {
    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await get(noAgentHandler, '/status');
      expect(result.status).toBe(503);
      expect(result.body.error).toContain('not available');
      noAgentHandler.destroy();
    });

    it('returns status with empty repos list initially', async () => {
      const result = await get(handler, '/status');
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.repos).toEqual([]);
      expect(result.body.dkgEnabled).toBe(true);
      expect(result.body.peerId).toBe('test-peer-1');
    });
  });

  // =========================================================================
  // GET /config
  // =========================================================================

  describe('GET /config', () => {
    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await get(noAgentHandler, '/config');
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });

    it('returns config with empty repos', async () => {
      const result = await get(handler, '/config');
      expect(result.status).toBe(200);
      expect(result.body.repos).toEqual([]);
      expect(result.body.githubTokenConfigured).toBe(false);
    });
  });

  // =========================================================================
  // POST /config/repo
  // =========================================================================

  describe('POST /config/repo', () => {
    it('returns 400 when owner is missing', async () => {
      const result = await post(handler, '/config/repo', { repo: 'test' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing owner');
    });

    it('returns 400 when repo is missing', async () => {
      const result = await post(handler, '/config/repo', { owner: 'octocat' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing');
    });

    it('adds a repo successfully', async () => {
      const result = await post(handler, '/config/repo', {
        owner: 'octocat',
        repo: 'Hello-World',
      });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.repoKey).toBe('octocat/Hello-World');
      expect(result.body.paranetId).toBeTruthy();
    });

    it('repo appears in config after adding', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World' });
      const config = await get(handler, '/config');
      expect(config.body.repos).toHaveLength(1);
      expect(config.body.repos[0].owner).toBe('octocat');
      expect(config.body.repos[0].repo).toBe('Hello-World');
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/config/repo', { owner: 'o', repo: 'r' });
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // DELETE /config/repo
  // =========================================================================

  describe('DELETE /config/repo', () => {
    it('removes a previously added repo', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World' });
      const result = await del(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World' });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);

      const config = await get(handler, '/config');
      expect(config.body.repos).toHaveLength(0);
    });

    it('returns 400 when owner or repo is missing', async () => {
      const result = await del(handler, '/config/repo', { owner: 'octocat' });
      expect(result.status).toBe(400);
    });
  });

  // =========================================================================
  // POST /webhook
  // =========================================================================

  describe('POST /webhook', () => {
    it('returns 400 when X-GitHub-Event header is missing', async () => {
      const result = await post(handler, '/webhook', { action: 'opened' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing X-GitHub-Event');
    });

    it('processes a valid webhook event', async () => {
      // Add a repo with a token so the sync engine has the config
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World', githubToken: 'ghp_test' });

      const req = createMockReq('POST', `${PREFIX}/webhook`, {
        action: 'opened',
        pull_request: { number: 1, title: 'Test' },
        repository: { full_name: 'octocat/Hello-World', owner: { login: 'octocat' }, name: 'Hello-World' },
      }, {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-1',
      });
      const mock = createMockRes();
      const url = new URL(`${PREFIX}/webhook`, 'http://localhost');
      await handler(req, mock.res, url);

      expect(mock.status).toBe(200);
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/webhook', { action: 'opened' }, {
        'x-github-event': 'push',
      });
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // POST /sync
  // =========================================================================

  describe('POST /sync', () => {
    it('returns 400 when owner or repo is missing', async () => {
      const result = await post(handler, '/sync', { owner: 'octocat' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing owner');
    });

    it('starts a sync job for a configured repo', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World', githubToken: 'ghp_test' });
      const result = await post(handler, '/sync', { owner: 'octocat', repo: 'Hello-World' });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.jobId).toBeTruthy();
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/sync', { owner: 'o', repo: 'r' });
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // GET /sync/status
  // =========================================================================

  describe('GET /sync/status', () => {
    it('returns 404 when job is not found', async () => {
      const result = await get(handler, '/sync/status', 'jobId=nonexistent');
      expect(result.status).toBe(404);
    });

    it('returns status for a started sync job', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World', githubToken: 'ghp_test' });
      const syncResult = await post(handler, '/sync', { owner: 'octocat', repo: 'Hello-World' });
      const jobId = syncResult.body.jobId;

      const result = await get(handler, '/sync/status', `jobId=${jobId}`);
      expect(result.status).toBe(200);
      expect(result.body.status).toBeTruthy();
    });

    it('returns status by repo key', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World', githubToken: 'ghp_test' });
      await post(handler, '/sync', { owner: 'octocat', repo: 'Hello-World' });

      const result = await get(handler, '/sync/status', 'repo=octocat/Hello-World');
      expect(result.status).toBe(200);
    });
  });

  // =========================================================================
  // POST /query
  // =========================================================================

  describe('POST /query', () => {
    it('returns 400 when sparql is missing', async () => {
      const result = await post(handler, '/query', { repo: 'octocat/Hello-World' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing sparql');
    });

    it('executes a SPARQL query', async () => {
      const result = await post(handler, '/query', {
        sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
        repo: 'octocat/Hello-World',
      });
      expect(result.status).toBe(200);
      expect(result.body.result).toBeDefined();
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/query', { sparql: 'SELECT * WHERE { ?s ?p ?o }' });
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // POST /auth/test
  // =========================================================================

  describe('POST /auth/test', () => {
    it('returns 400 when token is missing', async () => {
      const result = await post(handler, '/auth/test', {});
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing token');
    });

    // Note: actual token validation would require mocking fetch for GitHub API,
    // which is tested in github-client.test.ts. Just test the 400 case here.
  });

  // =========================================================================
  // POST /review/request
  // =========================================================================

  describe('POST /review/request', () => {
    it('returns 400 when owner/repo/prNumber missing', async () => {
      const result = await post(handler, '/review/request', { owner: 'octocat', repo: 'Hello-World' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing');
    });

    it('creates a review session for a configured repo', async () => {
      // Must add the repo first
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World' });

      const result = await post(handler, '/review/request', {
        owner: 'octocat',
        repo: 'Hello-World',
        prNumber: 42,
        reviewers: ['peer-1', 'peer-2'],
        requiredApprovals: 2,
      });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.sessionId).toBeTruthy();
    });

    it('returns 400 when repo is not configured', async () => {
      const result = await post(handler, '/review/request', {
        owner: 'unknown', repo: 'repo', prNumber: 1, reviewers: ['peer-1'],
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('not configured');
    });

    it('returns 400 when reviewers is empty', async () => {
      const result = await post(handler, '/review/request', {
        owner: 'octocat', repo: 'Hello-World', prNumber: 1,
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('At least one reviewer');
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/review/request', {
        owner: 'o', repo: 'r', prNumber: 1,
      });
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // GET /review/status
  // =========================================================================

  describe('GET /review/status', () => {
    it('returns 400 when sessionId is missing', async () => {
      const result = await get(handler, '/review/status');
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing sessionId');
    });

    it('returns 404 when session does not exist', async () => {
      const result = await get(handler, '/review/status', 'sessionId=nonexistent');
      expect(result.status).toBe(404);
    });

    it('returns session data for existing session', async () => {
      // Must add the repo first
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World' });
      const createResult = await post(handler, '/review/request', {
        owner: 'octocat', repo: 'Hello-World', prNumber: 42, reviewers: ['peer-1'],
      });
      const sessionId = createResult.body.sessionId;

      const result = await get(handler, '/review/status', `sessionId=${sessionId}`);
      expect(result.status).toBe(200);
      expect(result.body.sessionId).toBe(sessionId);
      expect(result.body.prNumber).toBe(42);
    });
  });

  // =========================================================================
  // GET /repos/:owner/:repo/prs
  // =========================================================================

  describe('GET /repos/:owner/:repo/prs', () => {
    it('returns PR list from graph query', async () => {
      const result = await get(handler, '/repos/octocat/Hello-World/prs');
      expect(result.status).toBe(200);
      expect(result.body.pullRequests).toBeDefined();
      expect(Array.isArray(result.body.pullRequests)).toBe(true);
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await get(noAgentHandler, '/repos/octocat/Hello-World/prs');
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // GET /repos/:owner/:repo/prs/:number
  // =========================================================================

  describe('GET /repos/:owner/:repo/prs/:number', () => {
    it('returns PR detail from graph query', async () => {
      const result = await get(handler, '/repos/octocat/Hello-World/prs/42');
      expect(result.status).toBe(200);
      expect(result.body.prNumber).toBe(42);
      expect(result.body.triples).toBeDefined();
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await get(noAgentHandler, '/repos/octocat/Hello-World/prs/42');
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // POST /convert-to-shared
  // =========================================================================

  describe('POST /convert-to-shared', () => {
    it('converts a local repo to shared and returns new paranetId', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World' });
      const result = await post(handler, '/convert-to-shared', { owner: 'octocat', repo: 'Hello-World' });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.paranetId).toBeTruthy();
      expect(result.body.paranetId).toMatch(/^github-collab:octocat\/Hello-World:.+$/);
    });

    it('returns 400 when owner or repo is missing', async () => {
      const result = await post(handler, '/convert-to-shared', { owner: 'octocat' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing');
    });

    it('returns 400 for unconfigured repo', async () => {
      const result = await post(handler, '/convert-to-shared', { owner: 'unknown', repo: 'repo' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('not configured');
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/convert-to-shared', { owner: 'o', repo: 'r' });
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // POST /invite
  // =========================================================================

  describe('POST /invite', () => {
    it('sends an invitation for a shared repo', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
      const result = await post(handler, '/invite', { owner: 'octocat', repo: 'Hello-World', peerId: 'peer-2' });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.invitationId).toBeTruthy();
      expect(result.body.toPeerId).toBe('peer-2');
    });

    it('returns 400 when owner, repo, or peerId is missing', async () => {
      const result = await post(handler, '/invite', { owner: 'octocat', repo: 'Hello-World' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('Missing');
    });

    it('returns 400 for local-only repo', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World', privacyLevel: 'local' });
      const result = await post(handler, '/invite', { owner: 'octocat', repo: 'Hello-World', peerId: 'peer-2' });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('shared mode');
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/invite', { owner: 'o', repo: 'r', peerId: 'p' });
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // GET /invitations
  // =========================================================================

  describe('GET /invitations', () => {
    it('returns empty sent and received by default', async () => {
      const result = await get(handler, '/invitations');
      expect(result.status).toBe(200);
      expect(result.body.sent).toEqual([]);
      expect(result.body.received).toEqual([]);
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await get(noAgentHandler, '/invitations');
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // POST /invitations/:id/accept
  // =========================================================================

  describe('POST /invitations/:id/accept', () => {
    it('returns 400 for unknown invitation', async () => {
      const result = await post(handler, '/invitations/inv-nonexistent/accept', {});
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('not found');
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/invitations/inv-1/accept', {});
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // POST /invitations/:id/decline
  // =========================================================================

  describe('POST /invitations/:id/decline', () => {
    it('returns 400 for unknown invitation', async () => {
      const result = await post(handler, '/invitations/inv-nonexistent/decline', {});
      expect(result.status).toBe(400);
      expect(result.body.error).toContain('not found');
    });

    it('returns 503 when no coordinator', async () => {
      const noAgentHandler = createHandler();
      const result = await post(noAgentHandler, '/invitations/inv-1/decline', {});
      expect(result.status).toBe(503);
      noAgentHandler.destroy();
    });
  });

  // =========================================================================
  // destroy()
  // =========================================================================

  describe('destroy', () => {
    it('is safe to call multiple times', () => {
      expect(() => handler.destroy()).not.toThrow();
      expect(() => handler.destroy()).not.toThrow();
    });

    it('handler without agent has safe destroy', () => {
      const noAgentHandler = createHandler();
      expect(() => noAgentHandler.destroy()).not.toThrow();
    });
  });
});
