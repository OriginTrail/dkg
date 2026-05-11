import { useCallback, useEffect, useMemo, useRef } from 'react';

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
  | 'connected';

export interface NodeEvent {
  type: NodeEventType;
  data: Record<string, unknown>;
}

type Listener = (event: NodeEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
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

function connect() {
  if (source) return;

  const token = typeof window !== 'undefined' ? (window as any).__DKG_TOKEN__ : undefined;
  const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
  source = new EventSource(url);

  const handleEvent = (type: NodeEventType) => (e: MessageEvent) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(e.data); } catch { /* empty payload is fine */ }
    const event: NodeEvent = { type, data };
    for (const fn of listeners) {
      try { fn(event); } catch { /* never crash listeners */ }
    }
  };

  source.addEventListener('join_request', handleEvent('join_request'));
  source.addEventListener('join_approved', handleEvent('join_approved'));
  source.addEventListener('join_rejected', handleEvent('join_rejected'));
  source.addEventListener('project_synced', handleEvent('project_synced'));
  source.addEventListener('memory_graph_changed', handleEvent('memory_graph_changed'));
  source.addEventListener('connected', handleEvent('connected'));

  source.onerror = () => {
    source?.close();
    source = null;
    if (listeners.size > 0) {
      reconnectTimer = setTimeout(connect, 3000);
    }
  };
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  source?.close();
  source = null;
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
