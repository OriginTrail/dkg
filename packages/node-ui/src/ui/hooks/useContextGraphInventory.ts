import { useCallback, useEffect } from 'react';
import { api } from '../api-wrapper.js';
import { currentApiToken } from '../lib/apiToken.js';
import { useProjectsStore } from '../stores/projects.js';
import { useNodeEvents } from './useNodeEvents.js';

let consumers = 0;
let generation = 0;
let authKey: string | undefined | null = null;
let inFlight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** One request owner for the shared graph array, freshness and errors. */
export function refreshContextGraphInventory(force = false): Promise<void> {
  const token = currentApiToken();
  if (authKey !== null && authKey !== token) {
    generation++;
    inFlight = null;
    useProjectsStore.setState({ contextGraphs: [], inventoryLoaded: false, inventoryError: null });
  }
  authKey = token;
  if (inFlight && !force) return inFlight;
  const request = ++generation;
  useProjectsStore.setState({ loading: true });
  const promise = Promise.resolve().then(() => api.fetchContextGraphs())
    .then(({ contextGraphs }) => {
      if (request !== generation || token !== currentApiToken()) return;
      if (!Array.isArray(contextGraphs)) throw new Error('Invalid context graph list response');
      useProjectsStore.setState({ contextGraphs, inventoryError: null, inventoryLoaded: true });
    })
    .catch(error => {
      if (request !== generation || token !== currentApiToken()) return;
      useProjectsStore.setState({ inventoryLoaded: true,
        inventoryError: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (request !== generation) return;
      inFlight = null;
      if (token !== currentApiToken() && consumers > 0) {
        void refreshContextGraphInventory();
      } else {
        useProjectsStore.setState({ loading: false });
      }
    });
  inFlight = promise;
  return promise;
}

function refreshWhenVisible() {
  if (!document.hidden) void refreshContextGraphInventory();
}

function retainInventory() {
  consumers++;
  if (consumers === 1 || authKey !== currentApiToken()) refreshWhenVisible();
  if (consumers === 1) {
    pollTimer = setInterval(refreshWhenVisible, 60_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
  }
  return () => {
    if (--consumers !== 0) return;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener('visibilitychange', refreshWhenVisible);
    // Last consumer unmounted: invalidate stale replies and settle the shared
    // flag even if the request never finishes. Chat must not remain disabled.
    generation++;
    inFlight = null;
    useProjectsStore.setState({ loading: false });
  };
}

export function useContextGraphInventory() {
  const contextGraphs = useProjectsStore(state => state.contextGraphs);
  const loading = useProjectsStore(state => state.loading);
  const loaded = useProjectsStore(state => state.inventoryLoaded);
  const error = useProjectsStore(state => state.inventoryError);
  useEffect(retainInventory, []);
  useNodeEvents(useCallback(event => {
    if (event.type === 'join_approved' || event.type === 'join_rejected' || event.type === 'project_synced') {
      void refreshContextGraphInventory();
    }
  }, []));
  return { contextGraphs, loading: loading || (!loaded && contextGraphs.length === 0), error };
}
