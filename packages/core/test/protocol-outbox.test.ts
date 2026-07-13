import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  ProtocolOutbox,
} from '../src/protocol-outbox.js';
import {
  RESPONSE_CACHE_BYTES,
  type ProtocolOutboxEntry,
  type ProtocolOutboxStore,
} from '../src/messenger-types.js';

const PEER_A = '12D3KooWMilesPlaceholder';
const PEER_B = '12D3KooWLexPlaceholder';
const PROTO = '/dkg/10.0.1/message';
const MSG_1 = '00000000-0000-4000-8000-000000000001';
const MSG_2 = '00000000-0000-4000-8000-000000000002';
const PAYLOAD = new TextEncoder().encode('payload-bytes');

function fixture() {
  const store = new InMemoryProtocolOutboxStore();
  const outbox = new ProtocolOutbox(store);
  return { store, outbox };
}

describe('ProtocolOutbox.enqueueFailure', () => {
  it('creates a new entry on first failure with default backoff', () => {
    const { outbox } = fixture();
    const t0 = 1_000_000;
    const entry = outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'reset', t0);

    expect(entry.peer).toBe(PEER_A);
    expect(entry.protocol).toBe(PROTO);
    expect(entry.messageId).toBe(MSG_1);
    expect(entry.attempts).toBe(1);
    expect(entry.firstFailureAt).toBe(t0);
    expect(entry.lastAttemptAt).toBe(t0);
    expect(entry.nextAttemptAt).toBe(t0 + DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS[0]);
    expect(entry.lastError).toBe('reset');
  });

  it('bumps attempts and reschedules on repeat failure for the same key', () => {
    const { outbox } = fixture();
    const t0 = 1_000_000;
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'first', t0);
    const second = outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'second', t0 + 2000);

    expect(second.attempts).toBe(2);
    expect(second.firstFailureAt).toBe(t0);
    expect(second.lastAttemptAt).toBe(t0 + 2000);
    expect(second.nextAttemptAt).toBe(t0 + 2000 + DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS[1]);
    expect(second.lastError).toBe('second');
  });

  it('treats different protocols on the same peer as independent entries', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, '/dkg/10.0.1/message', MSG_1, PAYLOAD, 'a', 1000);
    outbox.enqueueFailure(PEER_A, '/dkg/10.0.1/skill_request', MSG_1, PAYLOAD, 'b', 1000);
    expect(outbox.size()).toBe(2);
  });

  it('treats different messageIds as independent entries', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'a', 1000);
    outbox.enqueueFailure(PEER_A, PROTO, MSG_2, PAYLOAD, 'b', 1000);
    expect(outbox.size()).toBe(2);
  });

  it('snapshots payload bytes on write and read', () => {
    const { outbox } = fixture();
    const payload = new Uint8Array([1, 2, 3]);
    const entry = outbox.enqueueFailure(PEER_A, PROTO, MSG_1, payload, 'e', 1000);

    payload[0] = 9;
    entry.payload[1] = 8;

    const pending = outbox.list().filter((entry) => entry.peer === PEER_A);
    expect(Array.from(pending[0].payload)).toEqual([1, 2, 3]);

    pending[0].payload[2] = 7;
    expect(Array.from(outbox.due(6000)[0].payload)).toEqual([1, 2, 3]);
  });
});

describe('ProtocolOutbox.markDelivered + hasEntry', () => {
  it('markDelivered removes the entry and returns true', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    expect(outbox.hasEntry(PEER_A, PROTO, MSG_1)).toBe(true);
    expect(outbox.markDelivered(PEER_A, PROTO, MSG_1)).toBe(true);
    expect(outbox.hasEntry(PEER_A, PROTO, MSG_1)).toBe(false);
  });

  it('markDelivered returns false when no entry exists (first-attempt success)', () => {
    const { outbox } = fixture();
    expect(outbox.markDelivered(PEER_A, PROTO, MSG_1)).toBe(false);
  });

  it('hasEntry is the stale-snapshot guard required by the substrate contract', () => {
    // Models the rc9 #538 race: two overlapping scheduled drains both got the
    // same entry from a due snapshot, one completed delivery + markDelivered,
    // the other races to retry. The second MUST check `hasEntry` after
    // `tryBeginAttempt` returns true, because tryBeginAttempt only
    // guards against TRULY concurrent attempts, not stale-snapshot-
    // after-completion.
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    expect(outbox.tryBeginAttempt(PEER_A, PROTO, MSG_1)).toBe(true);
    // Sibling flush completes delivery in between.
    outbox.markDelivered(PEER_A, PROTO, MSG_1);
    // Caller MUST check `hasEntry` and bail.
    expect(outbox.hasEntry(PEER_A, PROTO, MSG_1)).toBe(false);
    outbox.endAttempt(PEER_A, PROTO, MSG_1);
  });
});

describe('ProtocolOutbox.tryBeginAttempt / endAttempt', () => {
  it('returns true exactly once for concurrent attempts on the same key', () => {
    const { outbox } = fixture();
    expect(outbox.tryBeginAttempt(PEER_A, PROTO, MSG_1)).toBe(true);
    expect(outbox.tryBeginAttempt(PEER_A, PROTO, MSG_1)).toBe(false);
    outbox.endAttempt(PEER_A, PROTO, MSG_1);
    expect(outbox.tryBeginAttempt(PEER_A, PROTO, MSG_1)).toBe(true);
  });

  it('different keys can hold inflight slots simultaneously', () => {
    const { outbox } = fixture();
    expect(outbox.tryBeginAttempt(PEER_A, PROTO, MSG_1)).toBe(true);
    expect(outbox.tryBeginAttempt(PEER_A, PROTO, MSG_2)).toBe(true);
    expect(outbox.tryBeginAttempt(PEER_B, PROTO, MSG_1)).toBe(true);
  });
});

describe('ProtocolOutbox.due / peer presence', () => {
  it('due returns entries whose nextAttemptAt is at or before now', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    const expectedNext = 1000 + DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS[0];
    expect(outbox.due(expectedNext - 1)).toHaveLength(0);
    expect(outbox.due(expectedNext)).toHaveLength(1);
  });

  it('bounds due snapshots in retry-time order', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, 'third', PAYLOAD, 'e', 3000);
    outbox.enqueueFailure(PEER_A, PROTO, 'first', PAYLOAD, 'e', 1000);
    outbox.enqueueFailure(PEER_A, PROTO, 'second', PAYLOAD, 'e', 2000);
    const now = 3000 + DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS[0];
    expect(outbox.duePage(now, 2).map((entry) => entry.messageId)).toEqual(['first', 'second']);
  });

  it('normalizes limits once and deterministically orders exact timestamp ties', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, 'z-last', PAYLOAD, 'e', 1000);
    outbox.enqueueFailure(PEER_A, PROTO, 'a-first', PAYLOAD, 'e', 1000);
    const now = 1000 + DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS[0];

    expect(outbox.duePage(now, 1.9).map((entry) => entry.messageId)).toEqual(['a-first']);
    expect(outbox.duePage(now, Number.NaN).map((entry) => entry.messageId)).toEqual(['a-first', 'z-last']);
  });

  it('keeps legacy due/pendingFor stores compatible and sorts before applying the cap', () => {
    const backing = new InMemoryProtocolOutboxStore();
    const entry = (
      messageId: string,
      firstFailureAt: number,
    ): ProtocolOutboxEntry => ({
      peer: PEER_A,
      protocol: PROTO,
      messageId,
      payload: PAYLOAD,
      attempts: 1,
      firstFailureAt,
      lastAttemptAt: firstFailureAt,
      nextAttemptAt: 100,
      lastError: 'offline',
    });
    const newer = entry('a-newer-failure', 20);
    const older = entry('z-older-failure', 10);
    const legacyStore: ProtocolOutboxStore = {
      enqueue: backing.enqueue.bind(backing),
      markDelivered: backing.markDelivered.bind(backing),
      hasEntry: backing.hasEntry.bind(backing),
      pendingFor: (peer) => peer === PEER_A ? [newer, older] : [],
      due: () => [newer, older],
      dropExpired: backing.dropExpired.bind(backing),
      size: backing.size.bind(backing),
      list: backing.list.bind(backing),
      getEntry: backing.getEntry.bind(backing),
    };
    const outbox = new ProtocolOutbox(legacyStore);

    expect(outbox.duePage(100, 1).map((candidate) => candidate.messageId))
      .toEqual(['z-older-failure']);
    expect(outbox.due(100).map((candidate) => candidate.messageId))
      .toEqual(['z-older-failure', 'a-newer-failure']);
    expect(outbox.hasPendingFor(PEER_A)).toBe(true);
    expect(outbox.hasPendingFor(PEER_B)).toBe(false);
  });

  it('uses firstFailureAt before key ordering when nextAttemptAt ties', () => {
    const store = new InMemoryProtocolOutboxStore({ backoffs: [50, 10] });
    const outbox = new ProtocolOutbox(store, { backoffs: [50, 10] });
    outbox.enqueueFailure(PEER_A, PROTO, 'z-older-failure', PAYLOAD, 'first', 0);
    outbox.enqueueFailure(PEER_A, PROTO, 'z-older-failure', PAYLOAD, 'second', 90);
    outbox.enqueueFailure(PEER_A, PROTO, 'a-newer-failure', PAYLOAD, 'first', 50);

    const due = outbox.duePage(100, 1);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      messageId: 'z-older-failure',
      firstFailureAt: 0,
      nextAttemptAt: 100,
    });
  });

  it('hasPendingFor tracks peer rows without exposing a reconnect drain snapshot', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, MSG_2, PAYLOAD, 'e', 2000);
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    outbox.enqueueFailure(PEER_B, PROTO, MSG_1, PAYLOAD, 'e', 500);
    expect(outbox.hasPendingFor(PEER_A)).toBe(true);
    expect(outbox.hasPendingFor(PEER_B)).toBe(true);
    expect(outbox.hasPendingFor('peer-c')).toBe(false);

    const pending = outbox.pendingFor(PEER_A);
    expect(pending.map((entry) => entry.messageId)).toEqual([MSG_1, MSG_2]);
    pending[0].payload[0] = 99;
    expect(outbox.pendingFor(PEER_A)[0].payload[0]).toBe(PAYLOAD[0]);
  });
});

describe('ProtocolOutbox.dropExpired', () => {
  it('drops entries older than the default 24h maxAgeMs', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 0);
    const past24h = 24 * 60 * 60 * 1000 + 1;
    const dropped = outbox.dropExpired(past24h);
    expect(dropped).toHaveLength(1);
    expect(outbox.size()).toBe(0);
  });

  it('does not drop entries within the maxAgeMs window', () => {
    const { outbox } = fixture();
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 0);
    const dropped = outbox.dropExpired(24 * 60 * 60 * 1000 - 1);
    expect(dropped).toHaveLength(0);
    expect(outbox.size()).toBe(1);
  });

  it('applies ProtocolOutbox maxAgeMs to the wrapped store', () => {
    const store = new InMemoryProtocolOutboxStore();
    const outbox = new ProtocolOutbox(store, { maxAgeMs: 60 });
    outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 0);

    expect(outbox.dropExpired(60)).toHaveLength(0);
    expect(outbox.dropExpired(61)).toHaveLength(1);
  });
});

describe('ProtocolOutbox construction', () => {
  it('rejects empty backoff arrays at construction time', () => {
    const store = new InMemoryProtocolOutboxStore();
    expect(() => new ProtocolOutbox(store, { backoffs: [] })).toThrow(
      /backoffs must be non-empty/,
    );
  });

  it('caps backoff at the last ladder rung for attempts beyond the ladder length', () => {
    const store = new InMemoryProtocolOutboxStore();
    const outbox = new ProtocolOutbox(store, { backoffs: [10, 20, 30] });
    // Simulate 5 failures — should cap at 30 (last rung).
    let lastEntry = outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 0);
    for (let i = 0; i < 4; i++) {
      lastEntry = outbox.enqueueFailure(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', lastEntry.lastAttemptAt);
    }
    expect(lastEntry.attempts).toBe(5);
    // Last attempt happened at t = lastEntry.lastAttemptAt; nextAttemptAt
    // == lastAttemptAt + 30 (last-rung cap).
    expect(lastEntry.nextAttemptAt - lastEntry.lastAttemptAt).toBe(30);
  });
});

describe('InMemoryMessageIdempotencyStore', () => {
  it('check returns { seen: false } for unrecorded triples', () => {
    const store = new InMemoryMessageIdempotencyStore();
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: false });
  });

  it('check returns the cached response after record with a small payload', () => {
    const store = new InMemoryMessageIdempotencyStore();
    const resp = new TextEncoder().encode('ack');
    store.record(PEER_A, PROTO, MSG_1, 'in', resp);
    const result = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(result.seen).toBe(true);
    expect(result.seen && result.cachedResponse).toEqual(resp);
  });

  it('snapshots cached responses on write and read', () => {
    const store = new InMemoryMessageIdempotencyStore();
    const resp = new Uint8Array([1, 2, 3]);
    store.record(PEER_A, PROTO, MSG_1, 'in', resp);

    resp[0] = 9;
    const first = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(first.seen && Array.from(first.cachedResponse ?? [])).toEqual([1, 2, 3]);

    if (first.seen && first.cachedResponse) {
      first.cachedResponse[1] = 8;
    }
    const second = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(second.seen && Array.from(second.cachedResponse ?? [])).toEqual([1, 2, 3]);
  });

  it('check returns { seen: true } without cachedResponse for mark-only (oversize) responses', () => {
    const store = new InMemoryMessageIdempotencyStore();
    const oversize = new Uint8Array(RESPONSE_CACHE_BYTES + 1);
    store.record(PEER_A, PROTO, MSG_1, 'in', oversize);
    const result = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(result).toEqual({ seen: true });
  });

  it('record with undefined response stores mark-only sentinel', () => {
    const store = new InMemoryMessageIdempotencyStore();
    store.record(PEER_A, PROTO, MSG_1, 'in');
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: true });
  });

  it('direction partitions the namespace (Codex #534 lesson lifted)', () => {
    const store = new InMemoryMessageIdempotencyStore();
    store.record(PEER_A, PROTO, MSG_1, 'in');
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: true });
    expect(store.check(PEER_A, PROTO, MSG_1, 'out')).toEqual({ seen: false });
  });

  it('record is idempotent — re-recording the same triple does not throw', () => {
    const store = new InMemoryMessageIdempotencyStore();
    const resp = new TextEncoder().encode('ack');
    store.record(PEER_A, PROTO, MSG_1, 'in', resp);
    // Re-record with a different response — first record wins (matches
    // SQLite ON CONFLICT DO NOTHING semantics).
    store.record(PEER_A, PROTO, MSG_1, 'in', new TextEncoder().encode('ack-v2'));
    const result = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(result.seen && result.cachedResponse).toEqual(resp);
  });

  it('pruneOlderThan drops records whose ts < threshold', () => {
    let now = 1_000_000;
    const store = new InMemoryMessageIdempotencyStore({ clock: () => now });
    store.record(PEER_A, PROTO, MSG_1, 'in');
    now = 2_000_000;
    store.record(PEER_A, PROTO, MSG_2, 'in');
    expect(store.pruneOlderThan(1_500_000)).toBe(1);
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: false });
    expect(store.check(PEER_A, PROTO, MSG_2, 'in')).toEqual({ seen: true });
  });
});
