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
let inFlight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: CurrentAgentState) {
  state = next;
  emit();
}

function loadCurrentAgent() {
  if (inFlight) return inFlight;

  const loadGeneration = generation;
  setState({ ...state, loading: true, error: null });
  inFlight = api.fetchCurrentAgent()
    .then((data) => {
      if (loadGeneration !== generation) return;
      setState({ data, loading: false, error: null });
    })
    .catch((error) => {
      if (loadGeneration !== generation) return;
      setState({
        data: state.data,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load current agent',
      });
    })
    .finally(() => {
      if (loadGeneration === generation) inFlight = null;
    });

  return inFlight;
}

function startPolling() {
  if (pollTimer) return;
  void loadCurrentAgent();
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
}

export function useCurrentAgent() {
  const [snapshot, setSnapshot] = useState(state);

  useEffect(() => {
    const listener = () => setSnapshot(state);
    listeners.add(listener);
    setSnapshot(state);
    startPolling();

    return () => {
      listeners.delete(listener);
      stopPollingIfIdle();
    };
  }, []);

  return snapshot;
}
