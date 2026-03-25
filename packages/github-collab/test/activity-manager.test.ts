/**
 * Unit tests for src/dkg/activity-manager.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ActivityManager } from '../src/dkg/activity-manager.js';

function noop() {}

describe('ActivityManager', () => {
  let manager: ActivityManager;

  beforeEach(() => {
    manager = new ActivityManager(noop);
  });

  // =========================================================================
  // Session lifecycle
  // =========================================================================

  describe('session lifecycle', () => {
    it('startSession creates an active session', () => {
      const session = manager.startSession('agent-1', 'peer-1', { goal: 'Fix bug' });
      expect(session.sessionId).toMatch(/^sess-/);
      expect(session.agentName).toBe('agent-1');
      expect(session.peerId).toBe('peer-1');
      expect(session.goal).toBe('Fix bug');
      expect(session.status).toBe('active');
      expect(session.modifiedFiles).toEqual([]);
    });

    it('heartbeatSession updates lastHeartbeat', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const before = session.lastHeartbeat;
      // Small delay to ensure timestamp differs
      const updated = manager.heartbeatSession(session.sessionId);
      expect(updated.lastHeartbeat).toBeGreaterThanOrEqual(before);
    });

    it('heartbeatSession throws for unknown session', () => {
      expect(() => manager.heartbeatSession('nonexistent')).toThrow('not found');
    });

    it('heartbeatSession throws for ended session', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      manager.endSession(session.sessionId);
      expect(() => manager.heartbeatSession(session.sessionId)).toThrow('is ended');
    });

    it('addModifiedFiles tracks files', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const result = manager.addModifiedFiles(session.sessionId, ['src/a.ts', 'src/b.ts']);
      expect(result.session.modifiedFiles).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.warnings).toEqual([]);
    });

    it('addModifiedFiles deduplicates files', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      manager.addModifiedFiles(session.sessionId, ['src/a.ts']);
      const result = manager.addModifiedFiles(session.sessionId, ['src/a.ts', 'src/b.ts']);
      expect(result.session.modifiedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('addModifiedFiles returns warnings for claimed files', () => {
      const s1 = manager.startSession('agent-1', 'peer-1');
      const s2 = manager.startSession('agent-2', 'peer-2');
      manager.claimFiles(['src/a.ts'], s1.sessionId, 'agent-1', 'peer-1');
      const result = manager.addModifiedFiles(s2.sessionId, ['src/a.ts']);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].file).toBe('src/a.ts');
      expect(result.warnings[0].claimedBy).toBe('agent-1');
    });

    it('endSession sets status to ended and releases claims', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      manager.claimFiles(['src/a.ts'], session.sessionId, 'agent-1', 'peer-1');
      expect(manager.getActiveClaims()).toHaveLength(1);

      const result = manager.endSession(session.sessionId, 'Done');
      expect(result.session.status).toBe('ended');
      expect(result.session.summary).toBe('Done');
      expect(result.releasedClaims).toHaveLength(1);
      expect(manager.getActiveClaims()).toHaveLength(0);
    });

    it('endSession throws for unknown session', () => {
      expect(() => manager.endSession('nonexistent')).toThrow('not found');
    });

    it('getSessions returns all sessions', () => {
      manager.startSession('agent-1', 'peer-1');
      manager.startSession('agent-2', 'peer-2');
      expect(manager.getSessions()).toHaveLength(2);
    });

    it('getSessions filters by status', () => {
      const s1 = manager.startSession('agent-1', 'peer-1');
      manager.startSession('agent-2', 'peer-2');
      manager.endSession(s1.sessionId);
      expect(manager.getSessions({ status: 'active' })).toHaveLength(1);
      expect(manager.getSessions({ status: 'ended' })).toHaveLength(1);
    });
  });

  // =========================================================================
  // Claims
  // =========================================================================

  describe('claims', () => {
    it('claimFiles creates claims for unclaimed files', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const result = manager.claimFiles(['src/a.ts', 'src/b.ts'], session.sessionId, 'agent-1', 'peer-1');
      expect(result.claimed).toHaveLength(2);
      expect(result.conflicts).toHaveLength(0);
      expect(result.claimed[0].claimId).toMatch(/^clm-/);
      expect(result.claimed[0].filePath).toBe('src/a.ts');
    });

    it('claimFiles detects conflicts', () => {
      const s1 = manager.startSession('agent-1', 'peer-1');
      const s2 = manager.startSession('agent-2', 'peer-2');
      manager.claimFiles(['src/a.ts'], s1.sessionId, 'agent-1', 'peer-1');
      const result = manager.claimFiles(['src/a.ts'], s2.sessionId, 'agent-2', 'peer-2');
      expect(result.claimed).toHaveLength(0);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].file).toBe('src/a.ts');
      expect(result.conflicts[0].existingClaim.agentName).toBe('agent-1');
    });

    it('claimFiles allows same session to re-claim', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      manager.claimFiles(['src/a.ts'], session.sessionId, 'agent-1', 'peer-1');
      const result = manager.claimFiles(['src/a.ts'], session.sessionId, 'agent-1', 'peer-1');
      // Same session re-claiming should not conflict
      expect(result.conflicts).toHaveLength(0);
    });

    it('releaseClaim removes a claim', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const result = manager.claimFiles(['src/a.ts'], session.sessionId, 'agent-1', 'peer-1');
      const claimId = result.claimed[0].claimId;
      const released = manager.releaseClaim(claimId);
      expect(released).toBeDefined();
      expect(released!.claimId).toBe(claimId);
      expect(manager.getActiveClaims()).toHaveLength(0);
    });

    it('releaseClaim returns undefined for unknown claim', () => {
      expect(manager.releaseClaim('nonexistent')).toBeUndefined();
    });

    it('getActiveClaims returns all active claims', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      manager.claimFiles(['src/a.ts', 'src/b.ts'], session.sessionId, 'agent-1', 'peer-1');
      expect(manager.getActiveClaims()).toHaveLength(2);
    });
  });

  // =========================================================================
  // Decisions
  // =========================================================================

  describe('decisions', () => {
    it('recordDecision stores a decision', () => {
      const decision = manager.recordDecision({
        summary: 'Use JWT',
        rationale: 'Stateless auth',
        alternatives: ['Cookies', 'OAuth'],
        affectedFiles: ['src/auth.ts'],
        peerId: 'peer-1',
        agentName: 'agent-1',
      });
      expect(decision.decisionId).toMatch(/^dec-/);
      expect(decision.summary).toBe('Use JWT');
      expect(decision.alternatives).toEqual(['Cookies', 'OAuth']);
    });

    it('getDecisions returns all decisions', () => {
      manager.recordDecision({ summary: 'A', rationale: 'R', affectedFiles: [], peerId: 'p', agentName: 'a' });
      manager.recordDecision({ summary: 'B', rationale: 'R', affectedFiles: [], peerId: 'p', agentName: 'a' });
      expect(manager.getDecisions()).toHaveLength(2);
    });
  });

  // =========================================================================
  // Annotations
  // =========================================================================

  describe('annotations', () => {
    it('addAnnotation stores an annotation', () => {
      const annotation = manager.addAnnotation({
        targetUri: 'urn:github:o/r/file/src%2Fauth.ts',
        kind: 'finding',
        content: 'Missing error handling',
        peerId: 'peer-1',
        agentName: 'agent-1',
      });
      expect(annotation.annotationId).toMatch(/^ann-/);
      expect(annotation.kind).toBe('finding');
      expect(annotation.content).toBe('Missing error handling');
    });
  });

  // =========================================================================
  // Abandoned session cleanup
  // =========================================================================

  describe('cleanupAbandonedSessions', () => {
    it('abandons sessions with stale heartbeats', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      // Manually set lastHeartbeat to 10 minutes ago
      session.lastHeartbeat = Date.now() - 10 * 60 * 1000;
      const abandoned = manager.cleanupAbandonedSessions();
      expect(abandoned).toContain(session.sessionId);
      expect(manager.getSession(session.sessionId)!.status).toBe('abandoned');
    });

    it('does not abandon sessions with recent heartbeats', () => {
      manager.startSession('agent-1', 'peer-1');
      const abandoned = manager.cleanupAbandonedSessions();
      expect(abandoned).toHaveLength(0);
    });

    it('releases claims for abandoned sessions', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      manager.claimFiles(['src/a.ts'], session.sessionId, 'agent-1', 'peer-1');
      expect(manager.getActiveClaims()).toHaveLength(1);

      session.lastHeartbeat = Date.now() - 10 * 60 * 1000;
      manager.cleanupAbandonedSessions();
      expect(manager.getActiveClaims()).toHaveLength(0);
    });
  });

  // =========================================================================
  // Activity feed
  // =========================================================================

  describe('getActivity', () => {
    it('returns a unified timeline sorted by timestamp', () => {
      const s = manager.startSession('agent-1', 'peer-1', { goal: 'Fix bug' });
      manager.claimFiles(['src/a.ts'], s.sessionId, 'agent-1', 'peer-1');
      manager.recordDecision({
        summary: 'Use JWT',
        rationale: 'R',
        affectedFiles: [],
        peerId: 'peer-1',
        agentName: 'agent-1',
      });

      const activity = manager.getActivity();
      expect(activity.length).toBeGreaterThanOrEqual(3);
      // Should be sorted descending by timestamp
      for (let i = 1; i < activity.length; i++) {
        expect(activity[i - 1].timestamp).toBeGreaterThanOrEqual(activity[i].timestamp);
      }
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        manager.startSession(`agent-${i}`, 'peer-1');
      }
      const activity = manager.getActivity(3);
      expect(activity.length).toBe(3);
    });

    it('uses session:started type for all sessions start entries', () => {
      const s = manager.startSession('agent-1', 'peer-1', { goal: 'Work' });
      manager.endSession(s.sessionId, 'Done');
      const activity = manager.getActivity();
      const startEntry = activity.find(a => a.detail.includes('Started session'));
      expect(startEntry).toBeDefined();
      expect(startEntry!.type).toBe('session:started');
    });

    it('produces two entries for ended sessions', () => {
      const s = manager.startSession('agent-1', 'peer-1', { goal: 'Work' });
      manager.endSession(s.sessionId, 'Done');
      const activity = manager.getActivity();
      const sessionEntries = activity.filter(a => a.entityId === s.sessionId);
      expect(sessionEntries).toHaveLength(2);
      const types = sessionEntries.map(a => a.type).sort();
      expect(types).toEqual(['session:ended', 'session:started']);
    });

    it('includes annotations in the feed', () => {
      manager.addAnnotation({
        targetUri: 'urn:test',
        kind: 'suggestion',
        content: 'Refactor this',
        peerId: 'p',
        agentName: 'agent-1',
      });
      const activity = manager.getActivity();
      expect(activity.some(a => a.type === 'annotation:added')).toBe(true);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('concurrent sessions from different agents are independent', () => {
      const s1 = manager.startSession('agent-1', 'peer-1', { goal: 'Feature A' });
      const s2 = manager.startSession('agent-2', 'peer-2', { goal: 'Feature B' });
      expect(s1.sessionId).not.toBe(s2.sessionId);
      expect(manager.getSessions({ status: 'active' })).toHaveLength(2);
      manager.endSession(s1.sessionId);
      expect(manager.getSessions({ status: 'active' })).toHaveLength(1);
      expect(manager.getSession(s2.sessionId)!.status).toBe('active');
    });

    it('full lifecycle: heartbeat timeout → abandoned → claim release → new claim', () => {
      const s1 = manager.startSession('agent-1', 'peer-1');
      manager.claimFiles(['src/a.ts'], s1.sessionId, 'agent-1', 'peer-1');
      expect(manager.getActiveClaims()).toHaveLength(1);

      // Simulate timeout
      s1.lastHeartbeat = Date.now() - 10 * 60 * 1000;
      const abandoned = manager.cleanupAbandonedSessions();
      expect(abandoned).toContain(s1.sessionId);
      expect(manager.getSession(s1.sessionId)!.status).toBe('abandoned');
      expect(manager.getActiveClaims()).toHaveLength(0);

      // Another agent can now claim the same file
      const s2 = manager.startSession('agent-2', 'peer-2');
      const result = manager.claimFiles(['src/a.ts'], s2.sessionId, 'agent-2', 'peer-2');
      expect(result.claimed).toHaveLength(1);
      expect(result.conflicts).toHaveLength(0);
    });

    it('endSession with no modified files succeeds', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const result = manager.endSession(session.sessionId);
      expect(result.session.status).toBe('ended');
      expect(result.session.modifiedFiles).toEqual([]);
      expect(result.releasedClaims).toHaveLength(0);
    });

    it('endSession with no summary sets summary to undefined', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const result = manager.endSession(session.sessionId);
      expect(result.session.summary).toBeUndefined();
    });

    it('decision with empty alternatives array', () => {
      const decision = manager.recordDecision({
        summary: 'Only option',
        rationale: 'No other choice',
        alternatives: [],
        affectedFiles: ['src/main.ts'],
        peerId: 'peer-1',
        agentName: 'agent-1',
      });
      expect(decision.alternatives).toEqual([]);
      expect(decision.decisionId).toMatch(/^dec-/);
    });

    it('decision with undefined alternatives', () => {
      const decision = manager.recordDecision({
        summary: 'Straightforward',
        rationale: 'Obvious',
        affectedFiles: [],
        peerId: 'peer-1',
        agentName: 'agent-1',
      });
      expect(decision.alternatives).toBeUndefined();
    });

    it('addModifiedFiles throws for unknown session', () => {
      expect(() => manager.addModifiedFiles('nonexistent', ['src/a.ts'])).toThrow('not found');
    });

    it('heartbeatSession throws for abandoned session', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      session.lastHeartbeat = Date.now() - 10 * 60 * 1000;
      manager.cleanupAbandonedSessions();
      expect(() => manager.heartbeatSession(session.sessionId)).toThrow('is abandoned');
    });

    it('cleanupAbandonedSessions skips already ended sessions', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      manager.endSession(session.sessionId);
      session.lastHeartbeat = Date.now() - 10 * 60 * 1000;
      const abandoned = manager.cleanupAbandonedSessions();
      expect(abandoned).toHaveLength(0);
      expect(manager.getSession(session.sessionId)!.status).toBe('ended');
    });

    it('startSession without optional fields', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      expect(session.goal).toBeUndefined();
      expect(session.relatedPr).toBeUndefined();
      expect(session.relatedIssue).toBeUndefined();
    });

    it('startSession with relatedPr and relatedIssue', () => {
      const session = manager.startSession('agent-1', 'peer-1', {
        goal: 'Fix PR',
        relatedPr: 42,
        relatedIssue: 7,
      });
      expect(session.relatedPr).toBe(42);
      expect(session.relatedIssue).toBe(7);
    });

    it('getSession returns undefined for unknown session', () => {
      expect(manager.getSession('nonexistent')).toBeUndefined();
    });
  });

  // =========================================================================
  // RDF generation
  // =========================================================================

  describe('RDF generation', () => {
    it('generateSessionQuads produces correct quads', () => {
      const session = manager.startSession('agent-1', 'peer-1', { goal: 'Test' });
      const quads = manager.generateSessionQuads(session, 'octocat', 'Hello-World', 'test-graph');
      expect(quads.length).toBeGreaterThan(0);
      const types = quads.filter(q => q.predicate.endsWith('#type'));
      expect(types).toHaveLength(1);
      expect(types[0].object).toContain('AgentSession');
    });

    it('generateClaimQuads produces correct quads', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const result = manager.claimFiles(['src/a.ts'], session.sessionId, 'agent-1', 'peer-1');
      const quads = manager.generateClaimQuads(result.claimed[0], 'octocat', 'Hello-World', 'test-graph');
      expect(quads.length).toBeGreaterThan(0);
      const types = quads.filter(q => q.predicate.endsWith('#type'));
      expect(types[0].object).toContain('CodeClaim');
    });

    it('generateDecisionQuads produces correct quads', () => {
      const decision = manager.recordDecision({
        summary: 'Use JWT',
        rationale: 'Better',
        alternatives: ['Cookies'],
        affectedFiles: ['src/auth.ts'],
        peerId: 'p',
        agentName: 'a',
      });
      const quads = manager.generateDecisionQuads(decision, 'octocat', 'Hello-World', 'test-graph');
      expect(quads.length).toBeGreaterThan(0);
      const types = quads.filter(q => q.predicate.endsWith('#type'));
      expect(types[0].object).toContain('Decision');
      // Should have alternatives
      const alts = quads.filter(q => q.predicate.endsWith('#alternatives'));
      expect(alts).toHaveLength(1);
    });

    it('generateAnnotationQuads produces correct quads', () => {
      const annotation = manager.addAnnotation({
        targetUri: 'urn:test',
        kind: 'warning',
        content: 'Watch out',
        peerId: 'p',
        agentName: 'a',
      });
      const quads = manager.generateAnnotationQuads(annotation, 'octocat', 'Hello-World', 'test-graph');
      expect(quads.length).toBeGreaterThan(0);
      const types = quads.filter(q => q.predicate.endsWith('#type'));
      expect(types[0].object).toContain('Annotation');
    });

    it('generateSessionQuads includes modifiedFiles, relatedPr, relatedIssue', () => {
      const session = manager.startSession('agent-1', 'peer-1', {
        goal: 'Fix PR',
        relatedPr: 42,
        relatedIssue: 7,
      });
      manager.addModifiedFiles(session.sessionId, ['src/a.ts', 'src/b.ts']);
      const quads = manager.generateSessionQuads(session, 'octocat', 'Hello-World', 'test-graph');
      const modFiles = quads.filter(q => q.predicate.endsWith('#modifiedFile'));
      expect(modFiles).toHaveLength(2);
      const relatedPR = quads.filter(q => q.predicate.endsWith('#relatedPR'));
      expect(relatedPR).toHaveLength(1);
      expect(relatedPR[0].object).toContain('/pr/42');
      const relatedIssue = quads.filter(q => q.predicate.endsWith('#relatedIssue'));
      expect(relatedIssue).toHaveLength(1);
      expect(relatedIssue[0].object).toContain('/issue/7');
    });

    it('generateSessionQuads for ended session includes endedAt and summary', () => {
      const session = manager.startSession('agent-1', 'peer-1', { goal: 'Work' });
      manager.endSession(session.sessionId, 'All done');
      const quads = manager.generateSessionQuads(session, 'octocat', 'Hello-World', 'test-graph');
      const endedAt = quads.filter(q => q.predicate.endsWith('#endedAt'));
      expect(endedAt).toHaveLength(1);
      const summary = quads.filter(q => q.predicate.endsWith('#summary'));
      expect(summary).toHaveLength(1);
      expect(summary[0].object).toContain('All done');
    });

    it('generateDecisionQuads omits alternatives when empty', () => {
      const decision = manager.recordDecision({
        summary: 'Only option',
        rationale: 'No choice',
        alternatives: [],
        affectedFiles: [],
        peerId: 'p',
        agentName: 'a',
      });
      const quads = manager.generateDecisionQuads(decision, 'octocat', 'Hello-World', 'test-graph');
      const alts = quads.filter(q => q.predicate.endsWith('#alternatives'));
      expect(alts).toHaveLength(0);
    });

    it('generateDecisionQuads includes session link when sessionId present', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const decision = manager.recordDecision({
        summary: 'Choice',
        rationale: 'Reason',
        affectedFiles: ['src/x.ts'],
        peerId: 'peer-1',
        agentName: 'agent-1',
        sessionId: session.sessionId,
      });
      const quads = manager.generateDecisionQuads(decision, 'octocat', 'Hello-World', 'test-graph');
      const inSession = quads.filter(q => q.predicate.endsWith('#inSession'));
      expect(inSession).toHaveLength(1);
      expect(inSession[0].object).toContain(session.sessionId);
    });

    it('generateAnnotationQuads includes session link when sessionId present', () => {
      const session = manager.startSession('agent-1', 'peer-1');
      const annotation = manager.addAnnotation({
        targetUri: 'urn:test',
        kind: 'note',
        content: 'Note content',
        peerId: 'peer-1',
        agentName: 'agent-1',
        sessionId: session.sessionId,
      });
      const quads = manager.generateAnnotationQuads(annotation, 'octocat', 'Hello-World', 'test-graph');
      const inSession = quads.filter(q => q.predicate.endsWith('#inSession'));
      expect(inSession).toHaveLength(1);
    });
  });
});
