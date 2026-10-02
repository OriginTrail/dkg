import { useCallback, useEffect, useMemo, useRef } from 'react';
import { authHeaders } from '../http.js';
import { isEventStreamContentType, readEventStream, type EventStreamMessage } from '../lib/eventStream.js';

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

// Keyed by every NodeEventType, so a type added to the union must be added here.
const NODE_EVENT_TYPES: Record<NodeEventType, true> = {
  join_request: true,
  join_approved: true,
  join_rejected: true,
  project_synced: true,
  memory_graph_changed: true,
  notification: true,
  connected: true,
};
const EVENTS_PATH = '/api/events';
const RECONNECT_DELAY_MS = 3000;

const listeners = new Set<Listener>();
// The open stream's controller; aborting it closes the stream.
let connection: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
export const MEMORY_GRAPH_REFRESH_DEBOUNCE_MS = 350;

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

function isNodeEventType(type: string): type is NodeEventType {
  return Object.prototype.hasOwnProperty.call(NODE_EVENT_TYPES, type);
}

// Only the node's named events reach listeners; any other event is ignored.
function dispatch({ type, data: payload }: EventStreamMessage) {
  if (!isNodeEventType(type)) return;
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(payload); } catch { /* empty payload is fine */ }
  const event: NodeEvent = { type, data };
  for (const fn of listeners) {
    try { fn(event); } catch { /* never crash listeners */ }
  }
}

// One connection to the node's event stream. The API token is sent only in
// the Authorization header. Settles when the stream ends, fails or is aborted.
async function streamNodeEvents(signal: AbortSignal): Promise<void> {
  const res = await fetch(EVENTS_PATH, {
    headers: { Accept: 'text/event-stream', ...authHeaders() },
    cache: 'no-store',
    signal,
  });
  if (!res.ok || !res.body || !isEventStreamContentType(res.headers.get('content-type'))) return;
  await readEventStream(res.body, dispatch);
}

function connect() {
  if (connection) return;
  const current = new AbortController();
  connection = current;

  // Runs when this stream settles. Once aborted it is no longer the current
  // connection (a newer one may be); otherwise try again later while anyone
  // is listening.
  const closed = () => {
    if (connection !== current) return;
    connection = null;
    if (listeners.size > 0) {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  };
  void streamNodeEvents(current.signal).then(closed, closed);
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connection?.abort();
  connection = null;
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (listeners.size === 1) connect();
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
