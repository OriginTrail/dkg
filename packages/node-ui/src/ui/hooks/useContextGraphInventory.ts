import { useEffect } from 'react';
import { api } from '../api-wrapper.js';
import { currentApiToken } from '../lib/apiToken.js';
import { useProjectsStore } from '../stores/projects.js';
import { subscribeNodeEvents } from './useNodeEvents.js';
import { refreshCurrentAgent } from './useCurrentAgent.js';

let consumers = 0;
let mutationOwners = 0;
let generation = 0;
let authKey: string | undefined | null = null;
let inFlight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeEvents: (() => void) | null = null;

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
  const identity = refreshCurrentAgent();
  const request = ++generation;
  useProjectsStore.setState({ loading: true });
  const list = Promise.resolve().then(() => api.fetchContextGraphs({ fresh: force }))
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
      if (token !== currentApiToken() && consumers > 0) {
        void refreshContextGraphInventory();
      } else {
        useProjectsStore.setState({ loading: false });
      }
    });
  const promise = Promise.all([list, identity]).then(() => undefined).finally(() => {
    if (request === generation) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

/** Mutation completion shares ordering, auth isolation, freshness and error state with Retry. */
export async function refreshContextGraphInventoryAfterMutation() {
  const token = currentApiToken();
  mutationOwners++;
  try {
    await refreshContextGraphInventory(true);
    // An SSE/Retry can supersede this request. Wait for the current same-auth
    // workflow before returning inventory to the mutation's navigation step.
    for (;;) {
      if (token !== currentApiToken()) throw new Error('Credentials changed while refreshing context graphs');
      const current = inFlight;
      if (!current) break;
      await current;
    }
    const state = useProjectsStore.getState();
    if (state.inventoryError) throw new Error(state.inventoryError);
    return state.contextGraphs;
  } finally {
    mutationOwners--;
    releaseIdleInventory();
  }
}

function releaseIdleInventory() {
  if (consumers || mutationOwners) return;
  generation++;
  inFlight = null;
  useProjectsStore.setState({ loading: false });
}

function refreshWhenVisible() {
  if (!document.hidden) void refreshContextGraphInventory();
}

function retainInventory() {
  consumers++;
  if (consumers === 1 || authKey !== currentApiToken()) refreshWhenVisible();
  if (consumers === 1) {
    unsubscribeEvents = subscribeNodeEvents(event => {
      if (event.type === 'join_approved' || event.type === 'join_rejected' || event.type === 'project_synced') {
        void refreshContextGraphInventory(true);
      }
    });
    pollTimer = setInterval(refreshWhenVisible, 60_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
  }
  return () => {
    if (--consumers !== 0) return;
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener('visibilitychange', refreshWhenVisible);
    // Last consumer unmounted: invalidate stale replies and settle the shared
    // flag even if the request never finishes. Chat must not remain disabled.
    releaseIdleInventory();
  };
}

export function useContextGraphInventory() {
  const contextGraphs = useProjectsStore(state => state.contextGraphs);
  const loading = useProjectsStore(state => state.loading);
  const loaded = useProjectsStore(state => state.inventoryLoaded);
  const error = useProjectsStore(state => state.inventoryError);
  useEffect(retainInventory, []);
  return { contextGraphs, loading: loading || (!loaded && contextGraphs.length === 0), error };
}
