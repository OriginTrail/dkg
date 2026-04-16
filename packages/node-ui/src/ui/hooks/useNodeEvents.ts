import { useEffect, useRef } from 'react';
import { authHeaders } from '../api.js';

export type NodeEventType = 'join_request' | 'join_approved' | 'project_synced' | 'connected';

export interface NodeEvent {
  type: NodeEventType;
  data: Record<string, unknown>;
}

type Listener = (event: NodeEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
  source.addEventListener('project_synced', handleEvent('project_synced'));
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
