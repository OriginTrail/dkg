/**
 * Unit tests for src/dkg/protocol.ts
 */

import { describe, it, expect } from 'vitest';
import { APP_ID, encodeMessage, decodeMessage, type AppMessage } from '../src/dkg/protocol.js';

describe('protocol', () => {
  describe('APP_ID', () => {
    it('is github-collab', () => {
      expect(APP_ID).toBe('github-collab');
    });
  });

  describe('encodeMessage / decodeMessage', () => {
    it('round-trips a node:joined message', () => {
      const msg: AppMessage = {
        app: APP_ID,
        type: 'node:joined',
        peerId: 'peer-1',
        timestamp: Date.now(),
        repo: 'octocat/Hello-World',
        nodeName: 'test-node',
      };

      const encoded = encodeMessage(msg);
      expect(encoded).toBeInstanceOf(Uint8Array);

      const decoded = decodeMessage(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe('node:joined');
      expect(decoded!.peerId).toBe('peer-1');
      expect((decoded as any).repo).toBe('octocat/Hello-World');
    });

    it('round-trips a review:submitted message', () => {
      const msg: AppMessage = {
        app: APP_ID,
        type: 'review:submitted',
        peerId: 'peer-2',
        timestamp: 1700000000,
        repo: 'org/repo',
        prNumber: 42,
        sessionId: 'review-abc',
        decision: 'approve',
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe('review:submitted');
      expect((decoded as any).decision).toBe('approve');
      expect((decoded as any).sessionId).toBe('review-abc');
    });

    it('round-trips a ping message', () => {
      const msg: AppMessage = {
        app: APP_ID,
        type: 'ping',
        peerId: 'peer-1',
        timestamp: Date.now(),
        repos: ['org/repo-a', 'org/repo-b'],
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe('ping');
      expect((decoded as any).repos).toEqual(['org/repo-a', 'org/repo-b']);
    });

    it('round-trips a sync:announce message', () => {
      const msg: AppMessage = {
        app: APP_ID,
        type: 'sync:announce',
        peerId: 'peer-1',
        timestamp: Date.now(),
        repo: 'org/repo',
        scope: ['pull_requests', 'issues'],
        quadsWritten: 500,
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);
      expect(decoded).not.toBeNull();
      expect((decoded as any).quadsWritten).toBe(500);
    });

    it('round-trips an invite:sent message', () => {
      const msg: AppMessage = {
        app: APP_ID,
        type: 'invite:sent',
        peerId: 'peer-1',
        timestamp: Date.now(),
        invitationId: 'inv-123',
        repo: 'org/repo',
        paranetId: 'github-collab:org/repo:abc',
        targetPeerId: 'peer-2',
        nodeName: 'node-1',
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe('invite:sent');
      expect((decoded as any).targetPeerId).toBe('peer-2');
    });
  });

  describe('decodeMessage edge cases', () => {
    it('returns null for invalid JSON', () => {
      const garbage = new TextEncoder().encode('not-json');
      expect(decodeMessage(garbage)).toBeNull();
    });

    it('returns null for valid JSON with wrong app id', () => {
      const wrongApp = new TextEncoder().encode(JSON.stringify({
        app: 'other-app',
        type: 'ping',
        peerId: 'peer-1',
        timestamp: Date.now(),
      }));
      expect(decodeMessage(wrongApp)).toBeNull();
    });

    it('returns null for valid JSON without app field', () => {
      const noApp = new TextEncoder().encode(JSON.stringify({
        type: 'ping',
        peerId: 'peer-1',
      }));
      expect(decodeMessage(noApp)).toBeNull();
    });

    it('returns null for empty Uint8Array', () => {
      expect(decodeMessage(new Uint8Array(0))).toBeNull();
    });
  });
});
