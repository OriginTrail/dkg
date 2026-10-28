import { useEffect } from 'react';
import { api } from '../api-wrapper.js';
import { currentApiToken } from '../lib/apiToken.js';
import { useProjectsStore, type ContextGraph } from '../stores/projects.js';
import { subscribeNodeEvents } from './useNodeEvents.js';
import { ensureCurrentAgent, refreshCurrentAgent, retainCurrentAgent, useCurrentAgent } from './useCurrentAgent.js';

export type InventoryResult = { ok: true; contextGraphs: ContextGraph[] } | { ok: false; error: string };
type InventoryRequest = {
  promise: Promise<InventoryResult>;
  settle: (result: InventoryResult | Promise<InventoryResult>) => void;
};

let consumers = 0;
let mutationOwners = 0;
let authKey: string | undefined | null = null;
let active: InventoryRequest | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeEvents: (() => void) | null = null;
const credentialsChanged: InventoryResult = { ok: false, error: 'Credentials changed while refreshing context graphs' };

/** Every caller follows the current same-credential workflow, including forced supersession. */
export function refreshContextGraphInventory(force = false): Promise<InventoryResult> {
  const token = currentApiToken();
  if (authKey !== null && authKey !== token) {
    active?.settle(credentialsChanged);
    active = null;
    useProjectsStore.setState({ contextGraphs: [], inventoryLoaded: false, inventoryError: null });
  }
  authKey = token;
  if (active && !force) return active.promise;
  const previous = active;
  let settle!: InventoryRequest['settle'];
  const promise = new Promise<InventoryResult>(resolve => { settle = resolve; });
  const request = { promise, settle };
  active = request;
  // Promise adoption transfers all existing callers to the replacing workflow;
  // they need not wait for its superseded network request to finish.
  previous?.settle(promise);
  useProjectsStore.setState({ loading: true });
  const identity = force ? refreshCurrentAgent() : ensureCurrentAgent();
  const list = Promise.resolve().then(() => api.fetchContextGraphs({ fresh: force }))
    .then(({ contextGraphs }): InventoryResult => {
      if (!Array.isArray(contextGraphs)) throw new Error('Invalid context graph list response');
      return { ok: true, contextGraphs };
    })
    .catch((error): InventoryResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  void Promise.all([list, identity]).then(([result]) => {
    if (active !== request) return;
    active = null;
    if (token !== currentApiToken()) {
      settle(credentialsChanged);
      useProjectsStore.setState({ loading: false });
      if (consumers > 0) void refreshContextGraphInventory();
      return;
    }
    // The store and awaiters receive the same outcome. Failure retains the last
    // successful graphs; callers never reconstruct completion from that cache.
    useProjectsStore.setState(result.ok
      ? { contextGraphs: result.contextGraphs, inventoryError: null, inventoryLoaded: true, loading: false }
      : { inventoryError: result.error, inventoryLoaded: true, loading: false });
    settle(result);
  });
  return promise;
}

/** Keep the same workflow alive through modal unmount until its mutation completes. */
export async function refreshContextGraphInventoryAfterMutation(): Promise<InventoryResult> {
  const release = retainCurrentAgent();
  mutationOwners++;
  try { return await refreshContextGraphInventory(true); }
  finally { mutationOwners--; releaseIdleInventory(); release(); }
}

function releaseIdleInventory() {
  if (consumers || mutationOwners) return;
  active?.settle({ ok: false, error: 'Context graph inventory has no remaining consumers' });
  active = null;
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
    // Last consumer unmounted: release the request and settle the shared flag.
    releaseIdleInventory();
  };
}

export function useContextGraphInventory() {
  const identity = useCurrentAgent();
  const contextGraphs = useProjectsStore(state => state.contextGraphs);
  const loading = useProjectsStore(state => state.loading);
  const loaded = useProjectsStore(state => state.inventoryLoaded);
  const error = useProjectsStore(state => state.inventoryError);
  useEffect(retainInventory, []);
  const listLoading = loading || (!loaded && contextGraphs.length === 0);
  return { contextGraphs, loading: listLoading, error, identity,
    inventoryLoading: listLoading || identity.loading, inventoryError: error || identity.error };
}
