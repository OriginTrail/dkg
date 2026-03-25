/**
 * Placeholder test verifying the test infrastructure works.
 * Tests that all helpers can be imported and produce valid objects.
 */

import { describe, it, expect } from 'vitest';
import {
  makeMockAgent,
  createMockReq,
  createMockRes,
  sampleRepository,
  samplePullRequest,
  sampleReview,
  sampleIssue,
  sampleCommit,
  samplePullRequestWebhook,
  sampleReviewWebhook,
  sampleIssueWebhook,
} from './helpers/index.js';

describe('test infrastructure', () => {
  describe('makeMockAgent', () => {
    it('creates an agent with default peerId', () => {
      const agent = makeMockAgent();
      expect(agent.peerId).toBe('test-peer-1');
      expect(agent.identityId).toBe(0n);
    });

    it('creates an agent with custom peerId', () => {
      const agent = makeMockAgent('custom-peer');
      expect(agent.peerId).toBe('custom-peer');
    });

    it('tracks workspace writes', async () => {
      const agent = makeMockAgent();
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"val"', graph: 'urn:g' }];
      const result = await agent.writeToWorkspace('test-paranet', quads);
      expect(result.workspaceOperationId).toBeTruthy();
      expect(agent._workspaceWrites).toHaveLength(1);
      expect(agent._workspaceWrites[0]).toBe(quads);
    });

    it('tracks published quads', async () => {
      const agent = makeMockAgent();
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"val"', graph: 'urn:g' }];
      const result = await agent.publish('test-paranet', quads);
      expect(result.ual).toBe('did:dkg:test:ual');
      expect(agent._published).toHaveLength(1);
    });

    it('tracks gossip subscriptions', () => {
      const agent = makeMockAgent();
      agent.gossip.subscribe('test-topic');
      expect(agent._subscriptions.has('test-topic')).toBe(true);
    });

    it('injects gossip messages to registered handlers', () => {
      const agent = makeMockAgent();
      const received: any[] = [];
      agent.gossip.onMessage('test-topic', (topic: string, data: Uint8Array, from: string) => {
        received.push({ topic, data, from });
      });
      const payload = new Uint8Array([1, 2, 3]);
      agent._injectMessage('test-topic', payload, 'peer-abc');
      expect(received).toHaveLength(1);
      expect(received[0].from).toBe('peer-abc');
    });
  });

  describe('createMockReq / createMockRes', () => {
    it('creates a GET request', () => {
      const req = createMockReq('GET', '/api/test');
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/api/test');
    });

    it('creates a POST request with body', async () => {
      const body = { key: 'value' };
      const req = createMockReq('POST', '/api/test', body);
      expect(req.method).toBe('POST');

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', resolve);
      });
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      expect(parsed).toEqual(body);
    });

    it('creates a request with custom headers', () => {
      const req = createMockReq('POST', '/api/test', null, {
        'x-hub-signature-256': 'sha256=abc123',
      });
      expect(req.headers['x-hub-signature-256']).toBe('sha256=abc123');
    });

    it('captures response status and body', () => {
      const mock = createMockRes();
      mock.res.writeHead(200, { 'Content-Type': 'application/json' });
      mock.res.end(JSON.stringify({ ok: true }));
      expect(mock.status).toBe(200);
      expect(JSON.parse(mock.body)).toEqual({ ok: true });
    });
  });

  describe('GitHub fixtures', () => {
    it('sampleRepository has expected shape', () => {
      expect(sampleRepository.full_name).toBe('octocat/Hello-World');
      expect(sampleRepository.owner.login).toBe('octocat');
      expect(sampleRepository.default_branch).toBe('main');
    });

    it('samplePullRequest has expected shape', () => {
      expect(samplePullRequest.number).toBe(42);
      expect(samplePullRequest.state).toBe('open');
      expect(samplePullRequest.head.ref).toBe('feature-x');
      expect(samplePullRequest.base.ref).toBe('main');
    });

    it('sampleReview has expected shape', () => {
      expect(sampleReview.state).toBe('APPROVED');
      expect(sampleReview.user.login).toBe('reviewer-1');
    });

    it('sampleIssue has expected shape', () => {
      expect(sampleIssue.number).toBe(10);
      expect(sampleIssue.state).toBe('open');
      expect(sampleIssue.labels[0].name).toBe('bug');
    });

    it('sampleCommit has expected shape', () => {
      expect(sampleCommit.sha).toHaveLength(40);
      expect(sampleCommit.commit.message).toContain('feature X');
    });

    it('webhook payloads reference correct entities', () => {
      expect(samplePullRequestWebhook.action).toBe('opened');
      expect(samplePullRequestWebhook.pull_request.number).toBe(42);
      expect(sampleReviewWebhook.action).toBe('submitted');
      expect(sampleReviewWebhook.review.state).toBe('APPROVED');
      expect(sampleIssueWebhook.action).toBe('opened');
      expect(sampleIssueWebhook.issue.number).toBe(10);
    });
  });
});
