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
});
