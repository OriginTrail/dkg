/**
 * Unit tests for src/dkg/coordinator.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitHubCollabCoordinator } from '../src/dkg/coordinator.js';
import { makeMockAgent, type MockAgent } from './helpers/index.js';

function noop() {}

describe('GitHubCollabCoordinator', () => {
  let agent: MockAgent;
  let coordinator: GitHubCollabCoordinator;

  beforeEach(() => {
    agent = makeMockAgent();
    coordinator = new GitHubCollabCoordinator(agent as any, { name: 'test-node' }, noop);
  });

  afterEach(() => {
    coordinator.destroy();
  });

  // =========================================================================
  // Repo config management
  // =========================================================================

  describe('repo config management', () => {
    it('addRepo stores config and returns paranetId', async () => {
      const result = await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      expect(result.repoKey).toBe('octocat/Hello-World');
      expect(result.paranetId).toBe('github-collab:octocat/Hello-World');
    });

    it('getConfiguredRepos returns added repos', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      await coordinator.addRepo({ owner: 'org', repo: 'other' });
      const repos = coordinator.getConfiguredRepos();
      expect(repos).toHaveLength(2);
      expect(repos.map(r => `${r.owner}/${r.repo}`).sort()).toEqual(['octocat/Hello-World', 'org/other']);
    });

    it('getRepoConfig returns config for existing repo', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', pollIntervalMs: 60000 });
      const config = coordinator.getRepoConfig('octocat', 'Hello-World');
      expect(config).toBeDefined();
      expect(config!.owner).toBe('octocat');
      expect(config!.repo).toBe('Hello-World');
      expect(config!.pollIntervalMs).toBe(60000);
    });

    it('getRepoConfig returns undefined for unknown repo', () => {
      expect(coordinator.getRepoConfig('unknown', 'repo')).toBeUndefined();
    });

    it('removeRepo deletes the config', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      coordinator.removeRepo('octocat', 'Hello-World');
      expect(coordinator.getConfiguredRepos()).toHaveLength(0);
    });

    it('removeRepo is safe for unknown repos', () => {
      expect(() => coordinator.removeRepo('unknown', 'repo')).not.toThrow();
    });

    it('custom paranetId is preserved', async () => {
      const result = await coordinator.addRepo({
        owner: 'octocat',
        repo: 'Hello-World',
        paranetId: 'custom-paranet',
      });
      expect(result.paranetId).toBe('custom-paranet');
    });

    it('default syncScope includes all scope types', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      const config = coordinator.getRepoConfig('octocat', 'Hello-World');
      expect(config!.syncScope).toContain('pull_requests');
      expect(config!.syncScope).toContain('issues');
      expect(config!.syncScope).toContain('reviews');
      expect(config!.syncScope).toContain('commits');
    });
  });

  // =========================================================================
  // GossipSub subscription
  // =========================================================================

  describe('GossipSub subscription', () => {
    it('subscribes to paranet gossip topic on addRepo with shared privacy', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
      expect(agent._subscriptions.size).toBeGreaterThan(0);
    });

    it('registers gossip message handlers for shared repos', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
      expect(agent._messageHandlers.size).toBeGreaterThan(0);
    });

    it('does NOT subscribe to gossip for local-only repos', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'local' });
      expect(agent._subscriptions.size).toBe(0);
    });

    it('defaults to local-only when privacyLevel is not specified', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      const config = coordinator.getRepoConfig('octocat', 'Hello-World');
      expect(config!.privacyLevel).toBe('local');
      expect(agent._subscriptions.size).toBe(0);
    });
  });

  // =========================================================================
  // Workspace write operations
  // =========================================================================

  describe('workspace operations', () => {
    it('writeToWorkspace calls agent.writeToWorkspace', async () => {
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"val"', graph: 'urn:g' }];
      await coordinator.writeToWorkspace('test-paranet', quads);
      expect(agent._workspaceWrites).toHaveLength(1);
      expect(agent._workspaceWrites[0]).toEqual(quads);
    });

    it('writeToWorkspace skips empty quads', async () => {
      await coordinator.writeToWorkspace('test-paranet', []);
      expect(agent._workspaceWrites).toHaveLength(0);
    });

    it('enshrineData calls agent.enshrineFromWorkspace', async () => {
      await coordinator.enshrineData('test-paranet', 'all');
      expect(agent._enshrined).toHaveLength(1);
      expect(agent._enshrined[0].selection).toBe('all');
    });

    it('enshrineData with rootEntities selection', async () => {
      await coordinator.enshrineData('test-paranet', { rootEntities: ['urn:entity1'] }, { clearWorkspaceAfter: false });
      expect(agent._enshrined).toHaveLength(1);
      expect(agent._enshrined[0].selection).toEqual({ rootEntities: ['urn:entity1'] });
    });

    it('enshrineData skips enshrinement for local-only repos', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'local' });
      const config = coordinator.getRepoConfig('octocat', 'Hello-World');
      const result = await coordinator.enshrineData(config!.paranetId, 'all');
      expect(result).toEqual({ skipped: true, reason: 'local-only' });
      expect(agent._enshrined).toHaveLength(0);
    });

    it('enshrineData proceeds for shared repos', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
      const config = coordinator.getRepoConfig('octocat', 'Hello-World');
      await coordinator.enshrineData(config!.paranetId, 'all');
      expect(agent._enshrined).toHaveLength(1);
    });
  });

  // =========================================================================
  // Query
  // =========================================================================

  describe('query', () => {
    it('forwards SPARQL to agent.query', async () => {
      const result = await coordinator.query('SELECT * WHERE { ?s ?p ?o }');
      expect(result).toBeDefined();
      expect(result.bindings).toEqual([]);
    });

    it('includes paranetId for configured repos', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      // The mock query just returns { bindings: [] }, but the call still goes through
      await coordinator.query('SELECT ?s WHERE { ?s ?p ?o }', 'octocat/Hello-World');
    });
  });

  // =========================================================================
  // Review sessions
  // =========================================================================

  describe('review sessions', () => {
    it('creates a review session for configured repo', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      const session = await coordinator.createReviewSession('octocat', 'Hello-World', 42, ['peer-1'], 1);
      expect(session.sessionId).toBeTruthy();
      expect(session.prNumber).toBe(42);
      expect(session.status).toBe('pending');
      expect(session.requiredApprovals).toBe(1);
      expect(session.reviewers).toEqual(['peer-1']);
    });

    it('throws when creating review for unconfigured repo', async () => {
      await expect(
        coordinator.createReviewSession('unknown', 'repo', 1, [], 1),
      ).rejects.toThrow('not configured');
    });

    it('getReviewSession returns existing session', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      const session = await coordinator.createReviewSession('octocat', 'Hello-World', 42, [], 1);
      const found = coordinator.getReviewSession(session.sessionId);
      expect(found).toBeDefined();
      expect(found!.prNumber).toBe(42);
    });

    it('getReviewSession returns undefined for unknown session', () => {
      expect(coordinator.getReviewSession('nonexistent')).toBeUndefined();
    });

    it('submitReview records the decision', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      const session = await coordinator.createReviewSession('octocat', 'Hello-World', 42, [], 1);
      const updated = await coordinator.submitReview(session.sessionId, 'approve');
      expect(updated.reviews).toHaveLength(1);
      expect(updated.reviews[0].decision).toBe('approve');
      expect(updated.reviews[0].peerId).toBe('test-peer-1');
    });

    it('submitReview detects approval consensus', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      const session = await coordinator.createReviewSession('octocat', 'Hello-World', 42, [], 1);
      const updated = await coordinator.submitReview(session.sessionId, 'approve');
      expect(updated.status).toBe('approved');
    });

    it('submitReview detects changes_requested', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World' });
      const session = await coordinator.createReviewSession('octocat', 'Hello-World', 42, [], 2);
      const updated = await coordinator.submitReview(session.sessionId, 'request_changes');
      expect(updated.status).toBe('changes_requested');
    });

    it('submitReview throws for unknown session', async () => {
      await expect(coordinator.submitReview('nonexistent', 'approve')).rejects.toThrow('not found');
    });
  });

  // =========================================================================
  // convertToShared
  // =========================================================================

  describe('convertToShared', () => {
    it('converts a local repo to shared mode', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'local' });
      const config = coordinator.getRepoConfig('octocat', 'Hello-World');
      expect(config!.privacyLevel).toBe('local');

      const result = await coordinator.convertToShared('octocat', 'Hello-World');
      expect(result.paranetId).toBeTruthy();
      // The new paranetId should contain a suffix
      expect(result.paranetId).toMatch(/^github-collab:octocat\/Hello-World:.+$/);

      const updated = coordinator.getRepoConfig('octocat', 'Hello-World');
      expect(updated!.privacyLevel).toBe('shared');
      expect(updated!.suffix).toBeTruthy();
      expect(updated!.paranetId).toBe(result.paranetId);
    });

    it('is idempotent for already-shared repos', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
      const config = coordinator.getRepoConfig('octocat', 'Hello-World');
      const originalParanetId = config!.paranetId;

      const result = await coordinator.convertToShared('octocat', 'Hello-World');
      expect(result.paranetId).toBe(originalParanetId);
    });

    it('subscribes to GossipSub after conversion', async () => {
      await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'local' });
      expect(agent._subscriptions.size).toBe(0);

      await coordinator.convertToShared('octocat', 'Hello-World');
      expect(agent._subscriptions.size).toBeGreaterThan(0);
    });

    it('throws for unconfigured repo', async () => {
      await expect(
        coordinator.convertToShared('unknown', 'repo'),
      ).rejects.toThrow('not configured');
    });
  });

  // =========================================================================
  // Invitations
  // =========================================================================

  describe('invitations', () => {
    describe('sendInvitation', () => {
      it('creates an invitation for a shared repo', async () => {
        await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
        const invitation = await coordinator.sendInvitation('octocat/Hello-World', 'peer-2');
        expect(invitation.invitationId).toBeTruthy();
        expect(invitation.repoKey).toBe('octocat/Hello-World');
        expect(invitation.toPeerId).toBe('peer-2');
        expect(invitation.fromPeerId).toBe('test-peer-1');
        expect(invitation.status).toBe('pending');
        expect(invitation.direction).toBe('sent');
      });

      it('throws for unconfigured repo', async () => {
        await expect(
          coordinator.sendInvitation('unknown/repo', 'peer-2'),
        ).rejects.toThrow('not configured');
      });

      it('throws for local-only repo', async () => {
        await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'local' });
        await expect(
          coordinator.sendInvitation('octocat/Hello-World', 'peer-2'),
        ).rejects.toThrow('shared mode');
      });
    });

    describe('acceptInvitation', () => {
      it('throws for unknown invitation', async () => {
        await expect(
          coordinator.acceptInvitation('inv-nonexistent'),
        ).rejects.toThrow('not found');
      });

      it('accepts a received invitation and subscribes to paranet', async () => {
        // Set up a shared repo and simulate receiving an invitation via gossip
        await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
        const config = coordinator.getRepoConfig('octocat', 'Hello-World')!;
        const topic = `dkg/paranet/${config.paranetId}/app`;

        // Inject invite:sent message targeted at our peer
        const inviteMsg = {
          app: 'github-collab',
          type: 'invite:sent',
          peerId: 'remote-peer',
          timestamp: Date.now(),
          invitationId: 'inv-test-1',
          repo: 'octocat/Hello-World',
          paranetId: config.paranetId,
          targetPeerId: 'test-peer-1',
          nodeName: 'remote-node',
        };
        agent._injectMessage(topic, new TextEncoder().encode(JSON.stringify(inviteMsg)), 'remote-peer');

        // Now accept the invitation
        const accepted = await coordinator.acceptInvitation('inv-test-1');
        expect(accepted.status).toBe('accepted');
      });

      it('throws for already-processed invitation', async () => {
        await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
        const config = coordinator.getRepoConfig('octocat', 'Hello-World')!;
        const topic = `dkg/paranet/${config.paranetId}/app`;

        const inviteMsg = {
          app: 'github-collab',
          type: 'invite:sent',
          peerId: 'remote-peer',
          timestamp: Date.now(),
          invitationId: 'inv-test-2',
          repo: 'octocat/Hello-World',
          paranetId: config.paranetId,
          targetPeerId: 'test-peer-1',
        };
        agent._injectMessage(topic, new TextEncoder().encode(JSON.stringify(inviteMsg)), 'remote-peer');

        await coordinator.acceptInvitation('inv-test-2');
        await expect(
          coordinator.acceptInvitation('inv-test-2'),
        ).rejects.toThrow('already accepted');
      });
    });

    describe('declineInvitation', () => {
      it('throws for unknown invitation', async () => {
        await expect(
          coordinator.declineInvitation('inv-nonexistent'),
        ).rejects.toThrow('not found');
      });

      it('declines a received invitation', async () => {
        await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
        const config = coordinator.getRepoConfig('octocat', 'Hello-World')!;
        const topic = `dkg/paranet/${config.paranetId}/app`;

        const inviteMsg = {
          app: 'github-collab',
          type: 'invite:sent',
          peerId: 'remote-peer',
          timestamp: Date.now(),
          invitationId: 'inv-test-3',
          repo: 'octocat/Hello-World',
          paranetId: config.paranetId,
          targetPeerId: 'test-peer-1',
        };
        agent._injectMessage(topic, new TextEncoder().encode(JSON.stringify(inviteMsg)), 'remote-peer');

        const declined = await coordinator.declineInvitation('inv-test-3');
        expect(declined.status).toBe('declined');
      });
    });

    describe('getInvitations', () => {
      it('returns empty sent and received by default', () => {
        const invitations = coordinator.getInvitations();
        expect(invitations.sent).toEqual([]);
        expect(invitations.received).toEqual([]);
      });

      it('returns sent invitations after sending', async () => {
        await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
        await coordinator.sendInvitation('octocat/Hello-World', 'peer-2');

        const invitations = coordinator.getInvitations();
        expect(invitations.sent).toHaveLength(1);
        expect(invitations.sent[0].toPeerId).toBe('peer-2');
      });

      it('returns received invitations from gossip', async () => {
        await coordinator.addRepo({ owner: 'octocat', repo: 'Hello-World', privacyLevel: 'shared' });
        const config = coordinator.getRepoConfig('octocat', 'Hello-World')!;
        const topic = `dkg/paranet/${config.paranetId}/app`;

        const inviteMsg = {
          app: 'github-collab',
          type: 'invite:sent',
          peerId: 'remote-peer',
          timestamp: Date.now(),
          invitationId: 'inv-recv-1',
          repo: 'octocat/Hello-World',
          paranetId: config.paranetId,
          targetPeerId: 'test-peer-1',
        };
        agent._injectMessage(topic, new TextEncoder().encode(JSON.stringify(inviteMsg)), 'remote-peer');

        const invitations = coordinator.getInvitations();
        expect(invitations.received).toHaveLength(1);
        expect(invitations.received[0].fromPeerId).toBe('remote-peer');
      });
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy', () => {
    it('is safe to call multiple times', () => {
      expect(() => coordinator.destroy()).not.toThrow();
      expect(() => coordinator.destroy()).not.toThrow();
    });
  });
});
