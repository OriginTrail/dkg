import { describe, expect, it } from 'vitest';
import {
  codexSessionReducer,
  INITIAL_CODEX_SESSION_STATE,
  type CodexSessionState,
  type SessionEvent,
} from '../src/ui/codex/useCodexSession.js';

function reduce(state: CodexSessionState, event: SessionEvent) {
  return codexSessionReducer(state, event);
}

describe('Codex session reducer', () => {
  it('ignores a stale selection snapshot after a newer selection starts', () => {
    let state = reduce(INITIAL_CODEX_SESSION_STATE, { type: 'selection-started', threadId: 'thread-a' });
    state = reduce(state, { type: 'selection-started', threadId: 'thread-b' });
    const stale = reduce(state, { type: 'snapshot-loaded', threadId: 'thread-a', data: {
      thread: { id: 'thread-a', cwd: '/a', turns: [] },
    } });
    expect(stale).toBe(state);
    state = reduce(state, { type: 'snapshot-loaded', threadId: 'thread-b', data: {
      thread: { id: 'thread-b', cwd: '/b', turns: [] },
      sequence: 2,
    } });
    expect(state.thread?.id).toBe('thread-b');
  });

  it('does not resurrect an active turn when completion precedes the send acknowledgement', () => {
    let state = reduce(INITIAL_CODEX_SESSION_STATE, { type: 'selection-started', threadId: 'thread-a' });
    state = reduce(state, { type: 'snapshot-loaded', threadId: 'thread-a', data: {
      thread: { id: 'thread-a', cwd: '/a', turns: [] }, sequence: 1,
    } });
    state = reduce(state, { type: 'stream-event', threadId: 'thread-a', event: {
      sequence: 2, method: 'turn/completed', params: {
        threadId: 'thread-a', turn: { id: 'turn-fast', status: 'completed' },
      },
    } });
    expect(state.completedTurnIds).toContain('turn-fast');
    state = reduce(state, { type: 'send-acknowledged', threadId: 'thread-a', turnId: 'turn-fast' });
    expect(state.activeTurn).toBeNull();
  });

  it('recovers the active turn, pending requests, and memory from a reconnect snapshot', () => {
    let state = reduce(INITIAL_CODEX_SESSION_STATE, { type: 'selection-started', threadId: 'thread-a' });
    state = reduce(state, { type: 'snapshot-loaded', threadId: 'thread-a', data: {
      thread: { id: 'thread-a', cwd: '/a', turns: [] }, sequence: 1,
    } });
    expect(state.activeTurn).toBeNull();
    expect(state.pending).toEqual([]);

    // The turn started and an approval was requested while the stream was
    // down, and both events fell outside the bridge's bounded replay log.
    state = reduce(state, { type: 'external-loaded', threadId: 'thread-a', data: {
      thread: { id: 'thread-a', cwd: '/a', turns: [{ id: 'turn-missed', status: 'inProgress' }] },
      activeTurnId: 'turn-missed',
      pendingRequests: [{ id: 7, threadId: 'thread-a', kind: 'approval' }],
      memory: { settings: { dkgCapture: true }, records: [{ id: 'record-a' }] },
      externalActive: true,
    } });
    expect(state.activeTurn).toBe('turn-missed');
    expect(state.pending).toEqual([{ id: 7, threadId: 'thread-a', kind: 'approval' }]);
    expect(state.memory.records).toEqual([{ id: 'record-a' }]);
    expect(state.externalActive).toBe(true);

    // A completion this client already observed still wins over the snapshot.
    state = reduce(state, { type: 'stream-event', threadId: 'thread-a', event: {
      sequence: 2, method: 'turn/completed', params: {
        threadId: 'thread-a', turn: { id: 'turn-missed', status: 'completed' },
      },
    } });
    state = reduce(state, { type: 'external-loaded', threadId: 'thread-a', data: {
      thread: { id: 'thread-a', cwd: '/a', turns: [] },
      activeTurnId: 'turn-missed',
      pendingRequests: [],
    } });
    expect(state.activeTurn).toBeNull();
    expect(state.pending).toEqual([]);
    // A snapshot for another thread never reconciles this one.
    expect(reduce(state, { type: 'external-loaded', threadId: 'thread-b', data: {
      thread: { id: 'thread-b', cwd: '/b', turns: [] }, activeTurnId: 'turn-other',
    } })).toBe(state);
  });
});
