// @vitest-environment happy-dom

// The dashboard receives the node's API token in the page only when it is
// opened on the node host. Elsewhere it loads without one, and the operator
// enters it in the prompt. Every API client reads the token through
// `currentApiToken()`: the served token first, otherwise the entered one, kept
// in sessionStorage when the browser allows and in memory for the page if not.
// Uses the repo's happy-dom + react-dom/client createRoot idiom.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  apiTokenRequired,
  apiTokenSurvivesReload,
  currentApiToken,
  enteredApiToken,
  forgetEnteredApiToken,
  hasServedApiToken,
  onApiTokenKeptInMemory,
  saveEnteredApiToken,
} from '../src/ui/lib/apiToken.js';
import { authHeaders } from '../src/ui/http.js';
import { ApiTokenPrompt } from '../src/ui/components/ApiTokenPrompt.js';
import { refuseTabStorage } from './helpers/tab-storage.js';

const STORAGE_KEY = 'dkg.apiToken';

function probeResponds(status: number) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('{}', { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let restoreTabStorage: (() => void) | undefined;

function blockTabStorage(mode: 'blocked' | 'writesFail' = 'blocked') {
  restoreTabStorage = refuseTabStorage(mode);
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
  forgetEnteredApiToken();
});

afterEach(() => {
  restoreTabStorage?.();
  restoreTabStorage = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetEnteredApiToken();
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
});

describe('API token source', () => {
  it('uses the served token first', () => {
    window.__DKG_TOKEN__ = 'served-1';
    window.sessionStorage.setItem(STORAGE_KEY, 'entered-1');
    expect(currentApiToken()).toBe('served-1');
    expect(hasServedApiToken()).toBe(true);
    expect(authHeaders()).toEqual({ Authorization: 'Bearer served-1' });
  });

  it('reads a token entered earlier in this tab from any entry point', () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'entered-1');
    expect(hasServedApiToken()).toBe(false);
    expect(currentApiToken()).toBe('entered-1');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer entered-1' });
  });

  it('keeps a saved token for the tab, so it survives a reload', () => {
    const keptInMemory = vi.fn();
    const off = onApiTokenKeptInMemory(keptInMemory);

    expect(saveEnteredApiToken('  entered-2 \n')).toBe(true);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('entered-2');
    expect(currentApiToken()).toBe('entered-2');
    expect(apiTokenSurvivesReload()).toBe(true);
    expect(window.__DKG_TOKEN__).toBeUndefined();
    expect(keptInMemory).not.toHaveBeenCalled();
    off();
  });

  it('keeps the token in memory when tab storage is blocked, and says so', () => {
    blockTabStorage();
    const keptInMemory = vi.fn();
    const off = onApiTokenKeptInMemory(keptInMemory);

    expect(saveEnteredApiToken('entered-3')).toBe(false);
    expect(currentApiToken()).toBe('entered-3');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer entered-3' });
    expect(apiTokenSurvivesReload()).toBe(false);
    expect(keptInMemory).toHaveBeenCalledTimes(1);
    off();
  });

  it('when writes fail, keeps the token in memory and drops an older stored one', () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'older-token');
    blockTabStorage('writesFail');

    expect(saveEnteredApiToken('entered-3b')).toBe(false);
    expect(currentApiToken()).toBe('entered-3b');
    // The older token must not come back after a reload.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(apiTokenSurvivesReload()).toBe(false);
  });

  it('ignores blank input', () => {
    expect(saveEnteredApiToken('   ')).toBe(false);
    expect(currentApiToken()).toBeUndefined();
    expect(authHeaders()).toEqual({});
  });

  it('forgets only the entered token, never the served one', () => {
    saveEnteredApiToken('entered-4');
    forgetEnteredApiToken();
    expect(enteredApiToken()).toBeUndefined();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    window.__DKG_TOKEN__ = 'served-2';
    saveEnteredApiToken('entered-5');
    forgetEnteredApiToken();
    expect(currentApiToken()).toBe('served-2');
  });

  it('asks for a token only when the node rejects the current credentials', async () => {
    const fetchMock = probeResponds(401);
    saveEnteredApiToken('entered-6');
    expect(await apiTokenRequired()).toBe(true);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/agent/identity');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer entered-6');

    probeResponds(200);
    expect(await apiTokenRequired()).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await apiTokenRequired()).toBe(false);
  });
});

describe('ApiTokenPrompt', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = null;
    container = null;
  });

  async function render(reload = vi.fn()) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(ApiTokenPrompt, { reload }));
    });
    await flush();
    return { container, reload };
  }

  function typeToken(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function submitToken(form: HTMLFormElement, value: string) {
    await act(async () => { typeToken(form.querySelector('input')!, value); });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  }

  it('stays hidden when the page was served with a token', async () => {
    window.__DKG_TOKEN__ = 'served-3';
    const fetchMock = probeResponds(401);
    const { container } = await render();
    expect(container.querySelector('form')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays hidden when the node accepts the request (authentication disabled)', async () => {
    probeResponds(200);
    const { container } = await render();
    expect(container.querySelector('form')).toBeNull();
  });

  it('collects a token, keeps it for the tab and reloads', async () => {
    probeResponds(401);
    const { container, reload } = await render();

    const form = container.querySelector('form')!;
    expect(form.getAttribute('aria-label')).toBe('Node API token');
    const input = form.querySelector('input')!;
    expect(input.type).toBe('password');
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await submitToken(form, ' entered-7 ');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('entered-7');
    expect(currentApiToken()).toBe('entered-7');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('with tab storage blocked, keeps the submitted token usable without reloading', async () => {
    blockTabStorage();
    probeResponds(401);
    const keptInMemory = vi.fn();
    const off = onApiTokenKeptInMemory(keptInMemory);
    const { container, reload } = await render();

    await submitToken(container.querySelector('form')!, ' entered-8 ');

    // A reload would discard the only copy, so the dashboard refreshes in place.
    expect(reload).not.toHaveBeenCalled();
    expect(keptInMemory).toHaveBeenCalledTimes(1);
    expect(currentApiToken()).toBe('entered-8');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer entered-8' });
    const fetchMock = probeResponds(200);
    expect(await apiTokenRequired()).toBe(false);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer entered-8');
    off();
  });

  it('drops an entered token the node rejects and asks again', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'stale-token');
    probeResponds(401);
    const { container } = await render();

    expect(container.textContent).toContain('the node did not accept that token');
    expect(enteredApiToken()).toBeUndefined();
    expect(currentApiToken()).toBeUndefined();
  });
});
