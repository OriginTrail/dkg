import { describe, it, expect } from 'vitest';
import {
  MessageOutbox,
  DEFAULT_CHAT_OUTBOX_BACKOFFS_MS,
  DEFAULT_CHAT_OUTBOX_MAX_AGE_MS,
  chatOutboxKey,
  type ChatOutboxPayload,
} from '../src/message-outbox.js';

const PEER_A = '12D3KooWPeerAFakeForOutboxTest';
const PEER_B = '12D3KooWPeerBFakeForOutboxTest';

function makePayload(overrides: Partial<ChatOutboxPayload> = {}): ChatOutboxPayload {
  return {
    recipientPeerId: PEER_A,
    text: 'hello',
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('MessageOutbox', () => {
  describe('key derivation', () => {
    it('composes recipient + messageId into a stable canonical key', () => {
      expect(chatOutboxKey(PEER_A, 'msg-1')).toBe(`${PEER_A}::msg-1`);
    });

    it('treats different messageIds to the same recipient as distinct entries', () => {
      const outbox = new MessageOutbox();
      outbox.enqueueFailure(makePayload({ messageId: 'm1' }), 'fail', 1000);
      outbox.enqueueFailure(makePayload({ messageId: 'm2' }), 'fail', 1100);
      expect(outbox.size()).toBe(2);
    });

    it('treats different recipients with same messageId as distinct entries', () => {
      const outbox = new MessageOutbox();
      outbox.enqueueFailure(makePayload({ recipientPeerId: PEER_A, messageId: 'm1' }), 'fail', 1000);
      outbox.enqueueFailure(makePayload({ recipientPeerId: PEER_B, messageId: 'm1' }), 'fail', 1100);
      expect(outbox.size()).toBe(2);
    });
  });

  describe('enqueueFailure semantics', () => {
    it('creates a new entry on first failure with attempts=1 and computed nextAttemptAt', () => {
      const outbox = new MessageOutbox({
        backoffs: [5_000, 15_000],
        maxAgeMs: 60_000,
      });
      const entry = outbox.enqueueFailure(makePayload(), 'transport reset', 1000);
      expect(entry).toMatchObject({
        recipientPeerId: PEER_A,
        text: 'hello',
        messageId: 'msg-1',
        attempts: 1,
        firstFailureAt: 1000,
        lastAttemptAt: 1000,
        nextAttemptAt: 1000 + 5_000,
        lastError: 'transport reset',
      });
    });

    it('bumps attempts and reschedules nextAttemptAt on repeat failure with same key', () => {
      const outbox = new MessageOutbox({
        backoffs: [5_000, 15_000, 30_000],
        maxAgeMs: 60_000,
      });
      outbox.enqueueFailure(makePayload(), 'first', 1000);
      const entry = outbox.enqueueFailure(makePayload(), 'second', 7000);
      expect(entry).toMatchObject({
        attempts: 2,
        firstFailureAt: 1000,
        lastAttemptAt: 7000,
        nextAttemptAt: 7000 + 15_000,
        lastError: 'second',
      });
    });

    it('caps backoff at the last entry of the ladder for high attempt counts', () => {
      const outbox = new MessageOutbox({
        backoffs: [5_000, 15_000],
        maxAgeMs: 60 * 60_000,
      });
      outbox.enqueueFailure(makePayload(), 'a1', 1000);
      outbox.enqueueFailure(makePayload(), 'a2', 2000);
      const entry = outbox.enqueueFailure(makePayload(), 'a3', 3000);
      expect(entry.attempts).toBe(3);
      expect(entry.nextAttemptAt).toBe(3000 + 15_000);
    });
  });

  describe('markDelivered', () => {
    it('removes the entry and returns true', () => {
      const outbox = new MessageOutbox();
      outbox.enqueueFailure(makePayload(), 'fail', 1000);
      expect(outbox.markDelivered(PEER_A, 'msg-1')).toBe(true);
      expect(outbox.size()).toBe(0);
    });

    it('returns false when no entry exists for the key', () => {
      const outbox = new MessageOutbox();
      expect(outbox.markDelivered(PEER_A, 'no-such-msg')).toBe(false);
    });
  });

  describe('due()', () => {
    it('returns only entries whose nextAttemptAt is at or before now', () => {
      const outbox = new MessageOutbox({
        backoffs: [5_000, 15_000],
        maxAgeMs: 60 * 60_000,
      });
      outbox.enqueueFailure(makePayload({ messageId: 'm1' }), 'fail', 1000);
      outbox.enqueueFailure(makePayload({ messageId: 'm2' }), 'fail', 2000);
      const due = outbox.due(6500);
      expect(due.map((e) => e.messageId)).toEqual(['m1']);
    });

    it('returns all entries when called far in the future', () => {
      const outbox = new MessageOutbox();
      outbox.enqueueFailure(makePayload({ messageId: 'm1' }), 'fail', 1000);
      outbox.enqueueFailure(makePayload({ messageId: 'm2' }), 'fail', 2000);
      expect(outbox.due(Number.MAX_SAFE_INTEGER)).toHaveLength(2);
    });
  });

  describe('pendingFor() — per-recipient FIFO', () => {
    it('returns entries for a single recipient sorted by firstFailureAt ascending', () => {
      const outbox = new MessageOutbox();
      outbox.enqueueFailure(makePayload({ messageId: 'm2' }), 'fail', 2000);
      outbox.enqueueFailure(makePayload({ messageId: 'm1' }), 'fail', 1000);
      outbox.enqueueFailure(makePayload({ messageId: 'm3' }), 'fail', 3000);
      const pending = outbox.pendingFor(PEER_A);
      expect(pending.map((e) => e.messageId)).toEqual(['m1', 'm2', 'm3']);
    });

    it('does not return entries for other recipients', () => {
      const outbox = new MessageOutbox();
      outbox.enqueueFailure(makePayload({ recipientPeerId: PEER_A, messageId: 'a' }), 'fail', 1000);
      outbox.enqueueFailure(makePayload({ recipientPeerId: PEER_B, messageId: 'b' }), 'fail', 1100);
      expect(outbox.pendingFor(PEER_A).map((e) => e.messageId)).toEqual(['a']);
      expect(outbox.pendingFor(PEER_B).map((e) => e.messageId)).toEqual(['b']);
    });

    it('returns entries regardless of nextAttemptAt (opportunistic flush semantic)', () => {
      const outbox = new MessageOutbox({
        backoffs: [5_000],
        maxAgeMs: 60_000,
      });
      outbox.enqueueFailure(makePayload({ messageId: 'soon' }), 'fail', 1000);
      // nextAttemptAt = 6000, but pendingFor doesn't filter by it
      const pending = outbox.pendingFor(PEER_A);
      expect(pending).toHaveLength(1);
      expect(pending[0].nextAttemptAt).toBe(6000);
    });
  });

  describe('dropExpired()', () => {
    it('drops entries older than maxAgeMs since firstFailureAt', () => {
      const outbox = new MessageOutbox({
        backoffs: [5_000],
        maxAgeMs: 1_000,
      });
      outbox.enqueueFailure(makePayload({ messageId: 'old' }), 'fail', 1000);
      outbox.enqueueFailure(makePayload({ messageId: 'new' }), 'fail', 5000);
      const dropped = outbox.dropExpired(5500);
      expect(dropped.map((e) => e.messageId)).toEqual(['old']);
      expect(outbox.size()).toBe(1);
    });
  });

  // 🔴 Regression for the duplicate-delivery race identified by Lex
  // review on PR #521. The periodic tick + connection:open
  // opportunistic flush can both call `retryOutboxEntry` for the same
  // entry: the first call's `messageHandler.sendChat` yields, the
  // second call observes the entry still in the queue (`markDelivered`
  // hasn't fired yet because the first send is still in flight) and
  // starts a concurrent second send. Without this guard the recipient
  // sees the message twice. The check-and-set on the inflight Set is
  // what catches the second concurrent attempter and returns false so
  // it exits without dialing.
  describe('inflight guard (PR #521 round-1 race fix)', () => {
    it('tryBeginAttempt returns true on first call and false on repeat', () => {
      const outbox = new MessageOutbox();
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-1')).toBe(true);
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-1')).toBe(false);
    });

    it('endAttempt releases the slot so subsequent tryBeginAttempt succeeds', () => {
      const outbox = new MessageOutbox();
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-1')).toBe(true);
      outbox.endAttempt(PEER_A, 'msg-1');
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-1')).toBe(true);
    });

    it('endAttempt is idempotent — releasing a non-held slot is a no-op', () => {
      const outbox = new MessageOutbox();
      // Never began. Should not throw and should not put the slot
      // into a corrupt state.
      expect(() => outbox.endAttempt(PEER_A, 'msg-1')).not.toThrow();
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-1')).toBe(true);
    });

    it('different keys are independent — distinct messageIds to same recipient do not block each other', () => {
      const outbox = new MessageOutbox();
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-1')).toBe(true);
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-2')).toBe(true);
    });

    it('different keys are independent — same messageId to different recipients do not block each other', () => {
      const outbox = new MessageOutbox();
      expect(outbox.tryBeginAttempt(PEER_A, 'msg-1')).toBe(true);
      expect(outbox.tryBeginAttempt(PEER_B, 'msg-1')).toBe(true);
    });
  });

  describe('defaults', () => {
    it('uses chat-tighter backoff ladder when not overridden', () => {
      expect(DEFAULT_CHAT_OUTBOX_BACKOFFS_MS).toEqual([
        5_000,
        15_000,
        30_000,
        60_000,
        5 * 60_000,
        30 * 60_000,
        2 * 60 * 60_000,
      ]);
    });

    it('defaults to 24h max age', () => {
      expect(DEFAULT_CHAT_OUTBOX_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('first-failure entry uses backoffs[0] = 5s by default', () => {
      const outbox = new MessageOutbox();
      const entry = outbox.enqueueFailure(makePayload(), 'fail', 1000);
      expect(entry.nextAttemptAt - entry.firstFailureAt).toBe(5_000);
    });
  });
});
