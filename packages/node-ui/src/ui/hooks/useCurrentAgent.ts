import { useEffect, useState } from 'react';
import { api } from '../api-wrapper.js';
import type { AgentIdentity } from '../api.js';

type CurrentAgentState = {
  data: AgentIdentity | null;
  loading: boolean;
  error: string | null;
};

const POLL_MS = 60_000;

let state: CurrentAgentState = {
  data: null,
  loading: true,
  error: null,
};
let inFlight: { authKey: string; promise: Promise<void> } | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
let stateAuthKey = '';
const listeners = new Set<() => void>();

function currentAuthKey() {
  if (typeof window === 'undefined') return '';
  const token = (window as any).__DKG_TOKEN__;
  return token ? `Bearer ${token}` : '';
}

function resetStateForAuthKey(authKey: string) {
  stateAuthKey = authKey;
  state = {
    data: null,
    loading: true,
    error: null,
  };
}

function snapshotForCurrentAuth() {
  const authKey = currentAuthKey();
  if (authKey !== stateAuthKey) resetStateForAuthKey(authKey);
  return state;
}

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: CurrentAgentState) {
  state = next;
  emit();
}

function loadCurrentAgent() {
  const loadGeneration = generation;
  const loadAuthKey = currentAuthKey();
  if (inFlight?.authKey === loadAuthKey) return inFlight.promise;

  if (loadAuthKey !== stateAuthKey) {
    resetStateForAuthKey(loadAuthKey);
    emit();
  } else {
    setState({ ...state, loading: true, error: null });
  }
  const promise = api.fetchCurrentAgent()
    .then((data) => {
      if (loadGeneration !== generation) return;
      if (loadAuthKey !== currentAuthKey()) {
        const authKey = currentAuthKey();
        const shouldLoadCurrentAuth = stateAuthKey !== authKey || state.loading;
        if (stateAuthKey !== authKey) {
          resetStateForAuthKey(authKey);
          emit();
        }
        if (shouldLoadCurrentAuth) void loadCurrentAgent();
        return;
      }
      setState({ data, loading: false, error: null });
    })
    .catch((error) => {
      if (loadGeneration !== generation) return;
      if (loadAuthKey !== currentAuthKey()) {
        const authKey = currentAuthKey();
        const shouldLoadCurrentAuth = stateAuthKey !== authKey || state.loading;
        if (stateAuthKey !== authKey) {
          resetStateForAuthKey(authKey);
          emit();
        }
        if (shouldLoadCurrentAuth) void loadCurrentAgent();
        return;
      }
      setState({
        data: state.data,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load current agent',
      });
    })
    .finally(() => {
      if (loadGeneration === generation && inFlight?.promise === promise) inFlight = null;
    });

  inFlight = { authKey: loadAuthKey, promise };

  return promise;
}

function startPolling() {
  void loadCurrentAgent();
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void loadCurrentAgent();
  }, POLL_MS);
}

function stopPollingIfIdle() {
  if (listeners.size > 0 || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  generation += 1;
  inFlight = null;
  state = {
    data: null,
    loading: true,
    error: null,
  };
  stateAuthKey = currentAuthKey();
}

export function useCurrentAgent() {
  const [snapshot, setSnapshot] = useState(snapshotForCurrentAuth);

  useEffect(() => {
    const listener = () => setSnapshot(snapshotForCurrentAuth());
    listeners.add(listener);
    setSnapshot(snapshotForCurrentAuth());
    startPolling();

    return () => {
      listeners.delete(listener);
      stopPollingIfIdle();
    };
  }, []);

  return snapshot;
}
