import { useCallback, useEffect, useReducer, useRef } from 'react';
import { callCodex } from './api.js';
import { applyEvent, type BridgeEvent, type Thread } from './events.js';
import type { MemoryData } from './MemoryPanel.js';

const EMPTY_MEMORY: MemoryData = { settings: null, records: [] };

export interface CodexSessionState {
  readonly thread: Thread | null;
  readonly memory: MemoryData;
  readonly pending: any[];
  readonly activeTurn: string | null;
  readonly externalActive: boolean;
  readonly streamConnected: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly selectingId: string | null;
  readonly completedTurnIds: readonly string[];
}

export const INITIAL_CODEX_SESSION_STATE: CodexSessionState = {
  thread: null,
  memory: EMPTY_MEMORY,
  pending: [],
  activeTurn: null,
  externalActive: false,
  streamConnected: false,
  busy: false,
  error: '',
  selectingId: null,
  completedTurnIds: [],
};

export type SessionEvent =
  | { type: 'selection-started'; threadId: string }
  | { type: 'snapshot-loaded'; threadId: string; data: any }
  | { type: 'selection-finished'; threadId: string }
  | { type: 'stream-event'; threadId: string; event: BridgeEvent }
  | { type: 'connection-changed'; threadId: string; connected: boolean }
  | { type: 'send-acknowledged'; threadId: string; turnId: string }
  | { type: 'memory-loaded'; threadId: string; memory: MemoryData }
  | { type: 'external-loaded'; threadId: string; data: any }
  | { type: 'request-resolved'; id: string | number }
  | { type: 'busy-changed'; busy: boolean }
  | { type: 'error-changed'; error: string };

export function codexSessionReducer(
  state: CodexSessionState,
  event: SessionEvent,
): CodexSessionState {
  if (event.type === 'selection-started') {
    return { ...state, selectingId: event.threadId, busy: true, error: '' };
  }
  if (event.type === 'snapshot-loaded') {
    if (state.selectingId !== event.threadId) return state;
    return {
      ...state,
      thread: event.data.thread,
      pending: event.data.pendingRequests ?? [],
      activeTurn: event.data.activeTurnId ?? null,
      memory: event.data.memory ?? EMPTY_MEMORY,
      externalActive: Boolean(event.data.externalActive),
      streamConnected: false,
    };
  }
  if (event.type === 'selection-finished') {
    return state.selectingId === event.threadId
      ? { ...state, selectingId: null, busy: false }
      : state;
  }
  if (event.type === 'connection-changed') {
    return state.thread?.id === event.threadId
      ? { ...state, streamConnected: event.connected }
      : state;
  }
  if (event.type === 'stream-event') {
    if (state.thread?.id !== event.threadId) return state;
    const bridgeEvent = event.event;
    let completedTurnIds = state.completedTurnIds;
    let activeTurn = state.activeTurn;
    let pending = state.pending;
    let memory = state.memory;
    let error = state.error;
    let thread = applyEvent(state.thread, bridgeEvent);
    if (bridgeEvent.method === 'memory/updated') {
      memory = { ...memory, records: [
        ...memory.records.filter((record) => record.id !== bridgeEvent.params.record.id),
        bridgeEvent.params.record,
      ] };
    }
    if (bridgeEvent.method === 'turn/started'
        && !completedTurnIds.includes(bridgeEvent.params.turn.id)) {
      activeTurn = bridgeEvent.params.turn.id;
    }
    if (bridgeEvent.method === 'turn/completed') {
      completedTurnIds = [...completedTurnIds, bridgeEvent.params.turn.id].slice(-1000);
      activeTurn = null;
    }
    if (bridgeEvent.method === 'bridge/request') {
      pending = [...pending.filter((request) => request.id !== bridgeEvent.params.id), bridgeEvent.params];
    }
    if (['bridge/requestResolved', 'serverRequest/resolved'].includes(bridgeEvent.method)) {
      pending = pending.filter((request) => String(request.id) !== String(bridgeEvent.params.requestId));
    }
    if (bridgeEvent.method === 'bridge/disconnected') {
      completedTurnIds = [];
      activeTurn = null;
      pending = [];
      error = 'Codex disconnected. Reopen the owner launch URL to reconnect. Your conversation is saved.';
    }
    if (bridgeEvent.method === 'error' && bridgeEvent.params.error) {
      error = bridgeEvent.params.error.message;
    }
    return { ...state, thread, memory, pending, activeTurn, completedTurnIds, error };
  }
  if (event.type === 'send-acknowledged') {
    if (state.thread?.id !== event.threadId) return state;
    return {
      ...state,
      activeTurn: state.completedTurnIds.includes(event.turnId) ? null : event.turnId,
    };
  }
  if (event.type === 'memory-loaded') {
    return state.thread?.id === event.threadId ? { ...state, memory: event.memory } : state;
  }
  if (event.type === 'external-loaded') {
    return state.thread?.id === event.threadId ? {
      ...state,
      thread: event.data.thread,
      externalActive: Boolean(event.data.externalActive),
    } : state;
  }
  if (event.type === 'request-resolved') {
    return { ...state, pending: state.pending.filter((request) => request.id !== event.id) };
  }
  if (event.type === 'busy-changed') return { ...state, busy: event.busy };
  return { ...state, error: event.error };
}

export function useCodexSession(loadList: () => Promise<void>) {
  const [state, dispatch] = useReducer(codexSessionReducer, INITIAL_CODEX_SESSION_STATE);
  const stream = useRef<EventSource | null>(null);
  const selected = useRef('');
  const selectionVersion = useRef(0);

  const connectEvents = useCallback((threadId: string, since: number) => {
    stream.current?.close();
    const source = new EventSource(`/api/codex/events?threadId=${encodeURIComponent(threadId)}&since=${since}`);
    stream.current = source;
    let opened = false;
    source.onopen = () => {
      if (selected.current !== threadId) return;
      dispatch({ type: 'connection-changed', threadId, connected: true });
      if (opened) void callCodex(`thread?id=${encodeURIComponent(threadId)}`).then((data) => {
        if (selected.current === threadId) dispatch({ type: 'external-loaded', threadId, data });
      }).catch((error) => dispatch({ type: 'error-changed', error: error.message }));
      opened = true;
    };
    source.onerror = () => {
      if (selected.current === threadId) {
        dispatch({ type: 'connection-changed', threadId, connected: false });
      }
    };
    source.onmessage = (message) => {
      if (selected.current !== threadId) return;
      const event: BridgeEvent = JSON.parse(message.data);
      dispatch({ type: 'stream-event', threadId, event });
      if (event.method === 'turn/completed') void loadList().catch(() => {});
    };
  }, [loadList]);

  const select = useCallback(async (threadId: string) => {
    const version = ++selectionVersion.current;
    dispatch({ type: 'selection-started', threadId });
    try {
      const data = await callCodex('select', { threadId });
      if (version !== selectionVersion.current) return;
      selected.current = threadId;
      dispatch({ type: 'snapshot-loaded', threadId, data });
      connectEvents(threadId, data.sequence);
    } catch (error) {
      if (version === selectionVersion.current) {
        dispatch({ type: 'error-changed', error: (error as Error).message });
      }
    } finally {
      if (version === selectionVersion.current) {
        dispatch({ type: 'selection-finished', threadId });
      }
    }
  }, [connectEvents]);

  useEffect(() => () => {
    ++selectionVersion.current;
    stream.current?.close();
  }, []);

  useEffect(() => {
    if (!state.thread?.id) return;
    const threadId = state.thread.id;
    const timer = setInterval(() => {
      void callCodex(`memory?threadId=${encodeURIComponent(threadId)}`).then((memory) => {
        if (selected.current === threadId) dispatch({ type: 'memory-loaded', threadId, memory });
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [state.thread?.id]);

  useEffect(() => {
    if (!state.externalActive || !state.thread?.id) return;
    const threadId = state.thread.id;
    const timer = setInterval(() => {
      void callCodex(`thread?id=${encodeURIComponent(threadId)}`).then((data) => {
        if (selected.current === threadId) dispatch({ type: 'external-loaded', threadId, data });
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [state.externalActive, state.thread?.id]);

  const isSelected = useCallback((threadId: string) => selected.current === threadId, []);
  const sendAcknowledged = useCallback((threadId: string, turnId: string) => {
    dispatch({ type: 'send-acknowledged', threadId, turnId });
  }, []);
  const resolveRequest = useCallback((id: string | number) => {
    dispatch({ type: 'request-resolved', id });
  }, []);
  const setBusy = useCallback((busy: boolean) => {
    dispatch({ type: 'busy-changed', busy });
  }, []);
  const setError = useCallback((error: string) => {
    dispatch({ type: 'error-changed', error });
  }, []);
  const setMemory = useCallback((threadId: string, memory: MemoryData) => {
    dispatch({ type: 'memory-loaded', threadId, memory });
  }, []);

  return {
    ...state,
    select,
    isSelected,
    sendAcknowledged,
    resolveRequest,
    setBusy,
    setError,
    setMemory,
  };
}
