// @vitest-environment happy-dom

// The dashboard's connection to the node's event stream: how it sends the API
// token, which events reach listeners, and when it reconnects.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { useNodeEvents, type NodeEvent } from '../src/ui/hooks/useNodeEvents.js';
import { forgetEnteredApiToken, saveEnteredApiToken } from '../src/ui/lib/apiToken.js';
import { stubNodeEventStream, type FakeNodeEventStream } from './helpers/fake-event-stream.js';

let events: FakeNodeEventStream;
let received: NodeEvent[];
const mounted = new Set<ReactRoot>();

function Listener() {
  useNodeEvents((event) => { received.push(event); });
  return null;
}

async function mountListener(): Promise<ReactRoot> {
  const root = createRoot(document.createElement('div'));
  mounted.add(root);
  await act(async () => { root.render(React.createElement(Listener)); });
  return root;
}

async function unmount(root: ReactRoot): Promise<void> {
  mounted.delete(root);
  await act(async () => { root.unmount(); });
}

function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  window.sessionStorage.clear();
  forgetEnteredApiToken();
  delete window.__DKG_TOKEN__;
  events = stubNodeEventStream();
  received = [];
});

afterEach(async () => {
  // Deleting the visited entry does not disturb a Set's iteration.
  for (const root of mounted) await unmount(root);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  forgetEnteredApiToken();
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
});

describe('event stream request', () => {
  it('sends the token only in the Authorization header', async () => {
    window.__DKG_TOKEN__ = 'node-token';
    await mountListener();
    expect(events.requests).toEqual([{
      url: '/api/events',
      headers: { accept: 'text/event-stream', authorization: 'Bearer node-token' },
      cache: 'no-store',
    }]);
  });

  it('sends no Authorization header when the page has no token', async () => {
    await mountListener();
    expect(events.requests).toEqual([{
      url: '/api/events',
      headers: { accept: 'text/event-stream' },
      cache: 'no-store',
    }]);
  });
});

describe('event delivery', () => {
  it('delivers the node events to listeners with parsed data, in order', async () => {
    await mountListener();
    await act(async () => {
      await events.latest().write('event: connected\ndata: {}\n\n');
      await events.latest().emit('join_request', { contextGraphId: 'cg-1', agentAddress: '0xabc' });
      await events.latest().emit('memory_graph_changed', { contextGraphId: 'cg-1', layers: ['wm'] });
    });
    expect(received).toEqual([
      { type: 'connected', data: {} },
      { type: 'join_request', data: { contextGraphId: 'cg-1', agentAddress: '0xabc' } },
      { type: 'memory_graph_changed', data: { contextGraphId: 'cg-1', layers: ['wm'] } },
    ]);
  });

  it('reads an event split across chunks with CRLF line endings and a heartbeat comment', async () => {
    await mountListener();
    const stream = events.latest();
    await act(async () => {
      await stream.write(': heartbeat\r\n\r\nevent: project_syn');
      await stream.write('ced\r');
      await stream.write('\ndata: {"contextGraphId":');
      await stream.write('"cg-1"}\r\n\r\n');
    });
    expect(received).toEqual([{ type: 'project_synced', data: { contextGraphId: 'cg-1' } }]);
  });

  it('ignores unnamed and unknown events and gives an unparseable payload as {}', async () => {
    await mountListener();
    await act(async () => {
      await events.latest().write('data: {"unnamed":true}\n\n');
      await events.latest().emit('some_other_event', { ignored: true });
      await events.latest().emit('toString', { ignored: true });
      await events.latest().write('event: notification\ndata: not json\n\n');
    });
    expect(received).toEqual([{ type: 'notification', data: {} }]);
  });

  it('keeps delivering to other listeners when one throws', async () => {
    function Throwing() {
      useNodeEvents(() => { throw new Error('listener failed'); });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    mounted.add(root);
    await act(async () => { root.render(React.createElement(Throwing)); });
    await mountListener();
    await act(async () => { await events.latest().emit('notification', { type: 'join_request' }); });
    expect(received).toEqual([{ type: 'notification', data: { type: 'join_request' } }]);
  });
});

describe('reconnection', () => {
  it('reconnects 3 s after the stream ends, with the token current at that time', async () => {
    saveEnteredApiToken('first-token');
    await mountListener();
    saveEnteredApiToken('second-token');
    await act(async () => { await events.latest().end(); });

    advance(2999);
    expect(events.requests).toHaveLength(1);
    advance(1);
    expect(events.requests.map((request) => [request.url, request.headers.authorization])).toEqual([
      ['/api/events', 'Bearer first-token'],
      ['/api/events', 'Bearer second-token'],
    ]);

    await act(async () => { await events.latest().emit('connected', {}); });
    expect(received).toEqual([{ type: 'connected', data: {} }]);
  });

  it('reconnects 3 s after the stream fails', async () => {
    await mountListener();
    await act(async () => { await events.latest().fail(); });
    advance(2999);
    expect(events.requests).toHaveLength(1);
    advance(1);
    expect(events.requests).toHaveLength(2);
  });

  // The refused and mistyped bodies hold a well-formed event, which must not be read.
  const EVENT_TEXT = 'event: notification\ndata: {}\n\n';
  it.each([
    ['a refused request', (stream: FakeNodeEventStream) => {
      stream.respondNextWith(new Response(EVENT_TEXT, {
        status: 401,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }],
    ['a network error', (stream: FakeNodeEventStream) => {
      stream.failNext();
    }],
    ['a response that is not an event stream', (stream: FakeNodeEventStream) => {
      stream.respondNextWith(new Response(EVENT_TEXT, { headers: { 'Content-Type': 'text/html' } }));
    }],
  ])('reconnects 3 s after %s', async (_case, arrange) => {
    arrange(events);
    await mountListener();
    await act(async () => { await events.settle(); });
    expect(events.connections).toHaveLength(0);
    expect(received).toEqual([]);

    advance(2999);
    expect(events.requests).toHaveLength(1);
    advance(1);
    expect(events.requests).toHaveLength(2);
    expect(events.connections).toHaveLength(1);
  });

  it('does not reconnect after the last listener unsubscribes', async () => {
    await unmount(await mountListener());
    expect(events.latest().aborted).toBe(true);
    await act(async () => { await events.settle(); });
    advance(60_000);
    expect(events.requests).toHaveLength(1);
  });

  it('cancels a pending reconnect when the last listener unsubscribes', async () => {
    const root = await mountListener();
    await act(async () => { await events.latest().end(); });
    await unmount(root);
    advance(60_000);
    expect(events.requests).toHaveLength(1);
  });

  it('shares one stream between listeners and aborts it with the last one', async () => {
    const first = await mountListener();
    const second = await mountListener();
    expect(events.requests).toHaveLength(1);
    await unmount(first);
    expect(events.latest().aborted).toBe(false);
    await unmount(second);
    expect(events.latest().aborted).toBe(true);
  });

  it('keeps the new stream when a remount replaces the listener', async () => {
    // As when Root remounts the dashboard: the old listener aborts its stream
    // and the new one connects in the same commit, before the abort settles.
    const root = createRoot(document.createElement('div'));
    mounted.add(root);
    await act(async () => { root.render(React.createElement(Listener, { key: 'before' })); });
    await act(async () => { root.render(React.createElement(Listener, { key: 'after' })); });
    await act(async () => { await events.settle(); });
    advance(60_000);
    expect(events.requests).toHaveLength(2);
    expect(events.connections.map((connection) => connection.aborted)).toEqual([true, false]);

    await act(async () => { await events.latest().emit('connected', {}); });
    expect(received).toEqual([{ type: 'connected', data: {} }]);
  });
});
