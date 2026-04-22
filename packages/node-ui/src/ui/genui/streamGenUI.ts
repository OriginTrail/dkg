/**
 * Client for the daemon's POST /api/genui/render endpoint.
 *
 * Returns an async iterator of SSE events. The caller typically accumulates
 * `delta.text` strings and feeds the concatenated string into the OpenUI
 * Renderer from @openuidev/react-lang, which parses streaming output and
 * progressively builds the component tree.
 */
import { authHeaders } from '../api.js';

export type GenuiEvent =
  | { type: 'start'; entityUri: string; entityRdfType: string | null; entityTypeLabel: string | null }
  | { type: 'delta'; text: string }
  | { type: 'final'; content: string }
  | { type: 'error'; error: string }
  | { type: 'done' };

export interface GenuiStreamOpts {
  contextGraphId: string;
  entityUri: string;
  libraryPrompt: string;
  signal?: AbortSignal;
}

export async function* streamGenUI(opts: GenuiStreamOpts): AsyncGenerator<GenuiEvent> {
  const res = await fetch('/api/genui/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      entityUri: opts.entityUri,
      libraryPrompt: opts.libraryPrompt,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err?.error) msg = err.error;
    } catch { /* body wasn't JSON */ }
    yield { type: 'error', error: msg };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by \n\n. Emit each complete frame.
      let frameEnd;
      while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const ev = parseSSE(frame);
        if (ev) yield ev;
      }
    }
    if (buffer.trim()) {
      const ev = parseSSE(buffer);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSSE(frame: string): GenuiEvent | null {
  let eventType = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    switch (eventType) {
      case 'start':
        return { type: 'start', ...parsed };
      case 'delta':
        return { type: 'delta', text: parsed.text ?? '' };
      case 'final':
        return { type: 'final', content: parsed.content ?? '' };
      case 'error':
        return { type: 'error', error: parsed.error ?? 'unknown error' };
      case 'done':
        return { type: 'done' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
