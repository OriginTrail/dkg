// @vitest-environment happy-dom

// Consumers that do not use the fetch Authorization header must also follow a
// token entered in the prompt: the SSE stream carries it as a query parameter,
// and the current-agent cache keys its loads by it.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { currentApiToken, forgetEnteredApiToken, saveEnteredApiToken } from '../src/ui/lib/apiToken.js';

const hoisted = vi.hoisted(() => ({
  fetchCurrentAgent: null as null | ((token: string | undefined) => Promise<unknown>),
  loadsUnderToken: [] as Array<string | undefined>,
}));

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchCurrentAgent: () => hoisted.fetchCurrentAgent!(undefined),
  },
}));

const { useNodeEvents } = await import('../src/ui/hooks/useNodeEvents.js');
const { useCurrentAgent } = await import('../src/ui/hooks/useCurrentAgent.js');

class RecordingEventSource {
  static urls: string[] = [];
  onerror: (() => void) | null = null;
  constructor(url: string) { RecordingEventSource.urls.push(url); }
  addEventListener() {}
  close() {}
}

const roots: ReactRoot[] = [];

async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return root;
}

async function unmountAll() {
  while (roots.length) {
    const root = roots.pop()!;
    await act(async () => { root.unmount(); });
  }
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
  forgetEnteredApiToken();
  RecordingEventSource.urls = [];
  hoisted.loadsUnderToken = [];
  vi.stubGlobal('EventSource', RecordingEventSource);
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
  forgetEnteredApiToken();
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
});

describe('SSE stream', () => {
  function Listener() {
    useNodeEvents(() => {});
    return null;
  }

  it('connects with an entered token', async () => {
    saveEnteredApiToken('remote token');
    await mount(React.createElement(Listener));
    expect(RecordingEventSource.urls).toEqual(['/api/events?token=remote%20token']);
  });

  it('prefers the token served with the page', async () => {
    window.__DKG_TOKEN__ = 'served-token';
    saveEnteredApiToken('remote token');
    await mount(React.createElement(Listener));
    expect(RecordingEventSource.urls).toEqual(['/api/events?token=served-token']);
  });
});

describe('current agent', () => {
  function Consumer() {
    useCurrentAgent();
    return null;
  }

  it('starts a fresh identity load when the entered token changes', async () => {
    // Keep each load pending so a second mount can only share it when the
    // auth key is unchanged.
    let release: () => void = () => {};
    hoisted.fetchCurrentAgent = () => {
      hoisted.loadsUnderToken.push(currentApiToken());
      return new Promise((resolve) => { release = () => resolve({ agentAddress: '0x0' }); });
    };

    saveEnteredApiToken('agent-token-a');
    await mount(React.createElement(Consumer));
    expect(hoisted.loadsUnderToken).toEqual(['agent-token-a']);

    // Same token: the pending load is shared.
    await mount(React.createElement(Consumer));
    expect(hoisted.loadsUnderToken).toEqual(['agent-token-a']);

    // New token: a new load under it.
    saveEnteredApiToken('agent-token-b');
    await mount(React.createElement(Consumer));
    expect(hoisted.loadsUnderToken).toEqual(['agent-token-a', 'agent-token-b']);

    release();
  });
});
