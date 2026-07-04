import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  dashboardSessionAuthKey,
  ensureDashboardSession,
  getDashboardSession,
  isDashboardSessionReady,
  subscribeDashboardSession,
  type DashboardSessionStatus,
} from '../dashboardSessionClient.js';

export type MemoryGraphLayer = 'wm' | 'swm' | 'vm';

export interface MemoryGraphChangedData extends Record<string, unknown> {
  contextGraphId?: string;
  layers?: MemoryGraphLayer[];
  layer?: MemoryGraphLayer;
  subGraphName?: string;
  operation?: string;
  source?: string;
  timestamp?: string;
}

export type NodeEventType =
  | 'join_request'
  | 'join_approved'
  | 'join_rejected'
  | 'project_synced'
  | 'memory_graph_changed'
  // Single generic notification refresh signal for the redesigned pane
  // (data-contract §4.5). Emitted once per scoped notification write; the
  // three join_* events above stay for other consumers
  // (PendingJoinRequestsSection, useMyContextGraphs). Payload `{ contextGraphId, type }`.
  | 'notification'
  | 'connected';

export interface NodeEvent {
  type: NodeEventType;
  data: Record<string, unknown>;
}

type Listener = (event: NodeEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let sourceAuthKey = '';
let connectPromise: Promise<void> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeDashboardSession: (() => void) | null = null;
export const MEMORY_GRAPH_REFRESH_DEBOUNCE_MS = 350;
const EVENT_SOURCE_RECONNECT_MS = 3000;
const EVENT_SOURCE_SESSION_REFRESH_MARGIN_MS = 5000;

function isMemoryGraphLayer(value: unknown): value is MemoryGraphLayer {
  return value === 'wm' || value === 'swm' || value === 'vm';
}

export function getMemoryGraphEventLayers(data: Record<string, unknown>): MemoryGraphLayer[] {
  const layers = data.layers;
  if (Array.isArray(layers)) {
    return layers.filter(isMemoryGraphLayer);
  }
  return isMemoryGraphLayer(data.layer) ? [data.layer] : [];
}

export function isMemoryGraphEventRelevant(
  data: Record<string, unknown>,
  contextGraphId: string,
  layers?: MemoryGraphLayer[],
): boolean {
  if (!contextGraphId || data.contextGraphId !== contextGraphId) return false;
  if (!layers || layers.length === 0) return true;

  const eventLayers = getMemoryGraphEventLayers(data);
  if (eventLayers.length === 0) return true;
  return layers.some(layer => eventLayers.includes(layer));
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearSessionRefreshTimer() {
  if (sessionRefreshTimer) {
    clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = null;
  }
}

function closeSource() {
  clearSessionRefreshTimer();
  source?.close();
  source = null;
  sourceAuthKey = '';
}

function shouldRefreshSessionForSse(session: DashboardSessionStatus): boolean {
  return session.state === 'authenticated' &&
    session.expiresAt <= Date.now() + EVENT_SOURCE_SESSION_REFRESH_MARGIN_MS;
}

function scheduleConnect(delayMs = 0) {
  if (listeners.size === 0) return;
  if (typeof EventSource === 'undefined') return;
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
}

function scheduleSessionRefresh(session: DashboardSessionStatus) {
  clearSessionRefreshTimer();
  if (session.state !== 'authenticated') return;
  const delayMs = Math.max(0, session.expiresAt - Date.now() - EVENT_SOURCE_SESSION_REFRESH_MARGIN_MS);
  sessionRefreshTimer = setTimeout(() => {
    closeSource();
    scheduleConnect(0);
  }, delayMs);
}

function watchDashboardSession() {
  if (unsubscribeDashboardSession) return;
  unsubscribeDashboardSession = subscribeDashboardSession(() => {
    const nextAuthKey = dashboardSessionAuthKey();
    if (source && nextAuthKey !== sourceAuthKey) {
      closeSource();
      scheduleConnect(0);
    } else if (!source && listeners.size > 0) {
      scheduleConnect(0);
    }
  });
}

function unwatchDashboardSession() {
  unsubscribeDashboardSession?.();
  unsubscribeDashboardSession = null;
}

async function connect() {
  if (source) return;
  if (connectPromise) return connectPromise;

  if (listeners.size === 0) return;
  if (typeof EventSource === 'undefined') return;

  clearReconnectTimer();

  connectPromise = (async () => {
    const session = await ensureDashboardSession();
    if (!isDashboardSessionReady(session)) return;
    if (source || listeners.size === 0 || typeof EventSource === 'undefined') return;

    const nextSource = new EventSource('/api/events');
    source = nextSource;
    sourceAuthKey = dashboardSessionAuthKey();
    scheduleSessionRefresh(session);

    const handleEvent = (type: NodeEventType) => (e: MessageEvent) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(e.data); } catch { /* empty payload is fine */ }
      const event: NodeEvent = { type, data };
      for (const fn of listeners) {
        try { fn(event); } catch { /* never crash listeners */ }
      }
    };

    nextSource.addEventListener('join_request', handleEvent('join_request'));
    nextSource.addEventListener('join_approved', handleEvent('join_approved'));
    nextSource.addEventListener('join_rejected', handleEvent('join_rejected'));
    nextSource.addEventListener('project_synced', handleEvent('project_synced'));
    nextSource.addEventListener('memory_graph_changed', handleEvent('memory_graph_changed'));
    nextSource.addEventListener('notification', handleEvent('notification'));
    nextSource.addEventListener('connected', handleEvent('connected'));

    nextSource.onerror = () => {
      if (source === nextSource) {
        closeSource();
      } else {
        nextSource.close();
      }
      if (listeners.size > 0) {
        scheduleConnect(shouldRefreshSessionForSse(getDashboardSession()) ? 0 : EVENT_SOURCE_RECONNECT_MS);
      }
    };
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

function disconnect() {
  clearReconnectTimer();
  closeSource();
  unwatchDashboardSession();
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (listeners.size === 1) {
    watchDashboardSession();
    void connect();
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) disconnect();
  };
}

/**
 * React hook: subscribe to real-time node events via SSE.
 * Pass a stable callback (or use useCallback) — the hook
 * auto-unsubscribes on unmount.
 */
export function useNodeEvents(handler: Listener) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe((event) => handlerRef.current(event));
  }, []);
}

export function useMemoryGraphEvents(
  contextGraphId: string,
  handler: (event: MemoryGraphChangedData) => void,
  options: { layers?: MemoryGraphLayer[]; debounceMs?: number } = {},
) {
  const handlerRef = useRef(handler);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  handlerRef.current = handler;

  const debounceMs = options.debounceMs ?? MEMORY_GRAPH_REFRESH_DEBOUNCE_MS;
  const layers = useMemo(() => options.layers ?? [], [options.layers?.join('|')]);

  const clearDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  useNodeEvents(useCallback((event) => {
    if (event.type !== 'memory_graph_changed') return;
    if (!isMemoryGraphEventRelevant(event.data, contextGraphId, layers)) return;

    clearDebounce();
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      handlerRef.current(event.data as MemoryGraphChangedData);
    }, debounceMs);
  }, [clearDebounce, contextGraphId, debounceMs, layers]));

  useEffect(() => clearDebounce, [clearDebounce]);
}
