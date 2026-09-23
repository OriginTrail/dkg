// @vitest-environment happy-dom

// The dashboard receives the node's API token in the page only when it is
// opened on the node host. Elsewhere it loads without one, and the operator
// enters it in the prompt; the token is kept for the tab in sessionStorage.
// Uses the repo's happy-dom + react-dom/client createRoot idiom.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  apiTokenRequired,
  enteredApiToken,
  forgetEnteredApiToken,
  hasServedApiToken,
  restoreEnteredApiToken,
  saveEnteredApiToken,
} from '../src/ui/lib/apiToken.js';
import { ApiTokenPrompt } from '../src/ui/components/ApiTokenPrompt.js';

const STORAGE_KEY = 'dkg.apiToken';

function probeResponds(status: number) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('{}', { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
});

describe('entered API token', () => {
  it('restores a token entered earlier in this tab', () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'entered-1');
    restoreEnteredApiToken();
    expect(window.__DKG_TOKEN__).toBe('entered-1');
    expect(hasServedApiToken()).toBe(false);
  });

  it('never replaces a token served with the page', () => {
    window.__DKG_TOKEN__ = 'served-1';
    window.sessionStorage.setItem(STORAGE_KEY, 'entered-1');
    restoreEnteredApiToken();
    expect(window.__DKG_TOKEN__).toBe('served-1');
    expect(hasServedApiToken()).toBe(true);
  });

  it('saves a trimmed token for the tab and ignores blank input', () => {
    saveEnteredApiToken('   ');
    expect(enteredApiToken()).toBeUndefined();
    expect(window.__DKG_TOKEN__).toBeUndefined();

    saveEnteredApiToken('  entered-2 \n');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('entered-2');
    expect(window.__DKG_TOKEN__).toBe('entered-2');
  });

  it('forgets only the entered token, never a served one', () => {
    saveEnteredApiToken('entered-3');
    forgetEnteredApiToken();
    expect(enteredApiToken()).toBeUndefined();
    expect(window.__DKG_TOKEN__).toBeUndefined();

    window.__DKG_TOKEN__ = 'served-2';
    window.sessionStorage.setItem(STORAGE_KEY, 'entered-4');
    forgetEnteredApiToken();
    expect(enteredApiToken()).toBeUndefined();
    expect(window.__DKG_TOKEN__).toBe('served-2');
  });

  it('keeps working when tab storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });

    restoreEnteredApiToken();
    expect(window.__DKG_TOKEN__).toBeUndefined();
    saveEnteredApiToken('entered-5');
    expect(window.__DKG_TOKEN__).toBe('entered-5');
    expect(() => forgetEnteredApiToken()).not.toThrow();
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

  async function render(onSaved = vi.fn()) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(ApiTokenPrompt, { onSaved }));
    });
    await flush();
    return { container, onSaved };
  }

  function typeToken(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

  it('collects a token when the node rejects the page, keeps it for the tab and reloads', async () => {
    probeResponds(401);
    const { container, onSaved } = await render();

    const form = container.querySelector('form')!;
    expect(form).not.toBeNull();
    expect(form.getAttribute('aria-label')).toBe('Node API token');
    const input = form.querySelector('input')!;
    expect(input.type).toBe('password');
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await act(async () => { typeToken(input, ' entered-7 '); });
    expect(submit.disabled).toBe(false);
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('entered-7');
    expect(window.__DKG_TOKEN__).toBe('entered-7');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('drops an entered token the node rejects and asks again', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'stale-token');
    restoreEnteredApiToken();
    probeResponds(401);
    const { container } = await render();

    expect(container.textContent).toContain('the node did not accept that token');
    expect(enteredApiToken()).toBeUndefined();
    expect(window.__DKG_TOKEN__).toBeUndefined();
  });
});
