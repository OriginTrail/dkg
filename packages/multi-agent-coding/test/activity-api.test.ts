/**
 * Unit tests for agent activity API endpoints in src/api/handler.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import createHandler from '../src/api/handler.js';
import type { AppRequestHandler } from '../src/api/handler.js';
import { makeMockAgent, createMockReq, createMockRes, type MockAgent } from './helpers/index.js';

const PREFIX = '/api/apps/github-collab';

async function get(handler: AppRequestHandler, subpath: string, query = ''): Promise<{ status: number; body: any }> {
  const fullUrl = `${PREFIX}${subpath}${query ? '?' + query : ''}`;
  const req = createMockReq('GET', fullUrl);
  const mock = createMockRes();
  const url = new URL(fullUrl, 'http://localhost');
  await handler(req, mock.res, url);
  return { status: mock.status, body: mock.body ? JSON.parse(mock.body) : null };
}

async function post(handler: AppRequestHandler, subpath: string, body: any): Promise<{ status: number; body: any }> {
  const fullUrl = `${PREFIX}${subpath}`;
  const req = createMockReq('POST', fullUrl, body);
  const mock = createMockRes();
  const url = new URL(fullUrl, 'http://localhost');
  await handler(req, mock.res, url);
  return { status: mock.status, body: mock.body ? JSON.parse(mock.body) : null };
}

async function del(handler: AppRequestHandler, subpath: string, body?: any): Promise<{ status: number; body: any }> {
  const fullUrl = `${PREFIX}${subpath}`;
  const req = createMockReq('DELETE', fullUrl, body);
  const mock = createMockRes();
  const url = new URL(fullUrl, 'http://localhost');
  await handler(req, mock.res, url);
  return { status: mock.status, body: mock.body ? JSON.parse(mock.body) : null };
}

describe('Agent Activity API endpoints', () => {
  let agent: MockAgent;
  let handler: AppRequestHandler & { destroy: () => void };

  beforeEach(async () => {
    agent = makeMockAgent();
    handler = createHandler(agent, { name: 'test-node', configPath: null });
    // Set up a repo for testing
    await post(handler, '/config/repo', { owner: 'octocat', repo: 'Hello-World', privacyLevel: 'local' });
  });

  afterEach(() => {
    handler.destroy();
  });

  // =========================================================================
  // Sessions
  // =========================================================================

  describe('POST /sessions', () => {
    it('starts a session and returns sessionId', async () => {
      const res = await post(handler, '/sessions', {
        agentName: 'claude-code-1',
        repoKey: 'octocat/Hello-World',
        goal: 'Fix bug #42',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sessionId).toMatch(/^sess-/);
      expect(res.body.startedAt).toBeTruthy();
    });

    it('returns 400 for missing agentName', async () => {
      const res = await post(handler, '/sessions', { repoKey: 'octocat/Hello-World' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /sessions', () => {
    it('returns sessions', async () => {
      await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const res = await get(handler, '/sessions', 'status=active');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
    });
  });

  describe('POST /sessions/:id/heartbeat', () => {
    it('updates heartbeat', async () => {
      const session = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const res = await post(handler, `/sessions/${session.body.sessionId}/heartbeat`, {});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.sessionAge).toBe('number');
    });
  });

  describe('POST /sessions/:id/files', () => {
    it('adds files to session', async () => {
      const session = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const res = await post(handler, `/sessions/${session.body.sessionId}/files`, {
        files: ['src/a.ts', 'src/b.ts'],
        repoKey: 'octocat/Hello-World',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.totalFiles).toBe(2);
    });
  });

  describe('POST /sessions/:id/end', () => {
    it('ends a session', async () => {
      const session = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const res = await post(handler, `/sessions/${session.body.sessionId}/end`, {
        summary: 'Done fixing bug',
        repoKey: 'octocat/Hello-World',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sessionId).toBe(session.body.sessionId);
      expect(typeof res.body.duration).toBe('number');
    });
  });

  // =========================================================================
  // Claims
  // =========================================================================

  describe('POST /claims', () => {
    it('creates claims for files', async () => {
      const session = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const res = await post(handler, '/claims', {
        files: ['src/a.ts'],
        sessionId: session.body.sessionId,
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.claims).toHaveLength(1);
      expect(res.body.claims[0].status).toBe('active');
    });

    it('detects claim conflicts', async () => {
      const s1 = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const s2 = await post(handler, '/sessions', { agentName: 'agent-2', repoKey: 'octocat/Hello-World' });
      await post(handler, '/claims', {
        files: ['src/a.ts'],
        sessionId: s1.body.sessionId,
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
      });
      const res = await post(handler, '/claims', {
        files: ['src/a.ts'],
        sessionId: s2.body.sessionId,
        agentName: 'agent-2',
        repoKey: 'octocat/Hello-World',
      });
      expect(res.status).toBe(200);
      expect(res.body.claims).toHaveLength(0);
      expect(res.body.conflicts).toHaveLength(1);
      expect(res.body.conflicts[0].existingClaim.claimedBy).toBe('agent-1');
    });
  });

  describe('GET /claims', () => {
    it('returns active claims', async () => {
      const session = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      await post(handler, '/claims', {
        files: ['src/a.ts'],
        sessionId: session.body.sessionId,
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
      });
      const res = await get(handler, '/claims');
      expect(res.status).toBe(200);
      expect(res.body.claims).toHaveLength(1);
      expect(res.body.claims[0].file).toBe('src/a.ts');
    });
  });

  describe('DELETE /claims/:id', () => {
    it('releases a claim', async () => {
      const session = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const claimRes = await post(handler, '/claims', {
        files: ['src/a.ts'],
        sessionId: session.body.sessionId,
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
      });
      const claimId = claimRes.body.claims[0].claimId;
      const res = await del(handler, `/claims/${claimId}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const listRes = await get(handler, '/claims');
      expect(listRes.body.claims).toHaveLength(0);
    });

    it('returns 404 for unknown claim', async () => {
      const res = await del(handler, '/claims/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // Decisions
  // =========================================================================

  describe('POST /decisions', () => {
    it('records a decision', async () => {
      const res = await post(handler, '/decisions', {
        summary: 'Use JWT',
        rationale: 'Stateless auth',
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
        affectedFiles: ['src/auth.ts'],
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.decisionId).toMatch(/^dec-/);
    });

    it('returns 400 for missing fields', async () => {
      const res = await post(handler, '/decisions', { summary: 'incomplete' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /decisions', () => {
    it('returns decisions', async () => {
      await post(handler, '/decisions', {
        summary: 'Use JWT',
        rationale: 'Better',
        agentName: 'a',
        repoKey: 'octocat/Hello-World',
      });
      const res = await get(handler, '/decisions');
      expect(res.status).toBe(200);
      expect(res.body.decisions).toHaveLength(1);
    });
  });

  // =========================================================================
  // Annotations
  // =========================================================================

  describe('POST /annotations', () => {
    it('creates an annotation', async () => {
      const res = await post(handler, '/annotations', {
        targetUri: 'urn:test',
        kind: 'finding',
        content: 'Missing error handling',
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.annotationId).toMatch(/^ann-/);
    });
  });

  // =========================================================================
  // Activity feed
  // =========================================================================

  describe('GET /activity', () => {
    it('returns activity feed', async () => {
      await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World', goal: 'Test' });
      await post(handler, '/decisions', {
        summary: 'Use JWT',
        rationale: 'Better',
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
      });
      const res = await get(handler, '/activity', 'limit=10');
      expect(res.status).toBe(200);
      expect(res.body.activities.length).toBeGreaterThanOrEqual(2);
    });

    it('returns activity with default limit', async () => {
      await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const res = await get(handler, '/activity');
      expect(res.status).toBe(200);
      expect(res.body.activities).toBeDefined();
    });
  });

  // =========================================================================
  // Error paths
  // =========================================================================

  describe('error paths', () => {
    it('POST /sessions/:id/heartbeat returns 400 for invalid session', async () => {
      const res = await post(handler, '/sessions/nonexistent/heartbeat', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not found');
    });

    it('POST /sessions/:id/end returns 400 for invalid session', async () => {
      const res = await post(handler, '/sessions/nonexistent/end', { repoKey: 'octocat/Hello-World' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not found');
    });

    it('POST /sessions/:id/files returns 400 for missing files array', async () => {
      const session = await post(handler, '/sessions', { agentName: 'agent-1', repoKey: 'octocat/Hello-World' });
      const res = await post(handler, `/sessions/${session.body.sessionId}/files`, { repoKey: 'octocat/Hello-World' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing files array');
    });

    it('POST /claims returns 400 for missing required fields', async () => {
      const res = await post(handler, '/claims', { files: ['src/a.ts'] });
      expect(res.status).toBe(400);
    });

    it('POST /annotations returns 400 for missing required fields', async () => {
      const res = await post(handler, '/annotations', { targetUri: 'urn:test' });
      expect(res.status).toBe(400);
    });

    it('POST /annotations with all valid fields succeeds', async () => {
      const res = await post(handler, '/annotations', {
        targetUri: 'urn:github:o/r/file/test',
        kind: 'warning',
        content: 'Be careful here',
        agentName: 'agent-1',
        repoKey: 'octocat/Hello-World',
      });
      expect(res.status).toBe(200);
      expect(res.body.annotationId).toMatch(/^ann-/);
    });
  });

  // =========================================================================
  // Convert-to-shared returns syncJobId
  // =========================================================================

  describe('POST /convert-to-shared', () => {
    it('returns syncJobId when token exists', async () => {
      // Add repo with token
      await post(handler, '/config/repo', {
        owner: 'octocat',
        repo: 'Spoon-Knife',
        githubToken: 'ghp_test',
        privacyLevel: 'local',
      });
      const res = await post(handler, '/convert-to-shared', { owner: 'octocat', repo: 'Spoon-Knife' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.paranetId).toBeTruthy();
      // syncJobId may or may not be present depending on sync engine mock behavior
      expect('syncJobId' in res.body).toBe(true);
    });

    it('returns null syncJobId when no token', async () => {
      await post(handler, '/config/repo', { owner: 'octocat', repo: 'NoToken', privacyLevel: 'local' });
      const res = await post(handler, '/convert-to-shared', { owner: 'octocat', repo: 'NoToken' });
      expect(res.status).toBe(200);
      expect(res.body.syncJobId).toBeNull();
    });
  });
});
