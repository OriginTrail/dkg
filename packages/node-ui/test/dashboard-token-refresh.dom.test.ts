// @vitest-environment happy-dom

// A token entered while tab storage is blocked lives only in the page, so
// nothing may reload it away: `Root` remounts the dashboard in place to refetch
// with it, and `useFetch` reloads once on a 401 only when the current token
// survives the reload.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { forgetEnteredApiToken, saveEnteredApiToken } from '../src/ui/lib/apiToken.js';
import { useFetch } from '../src/ui/hooks.js';
import { refuseTabStorage } from './helpers/tab-storage.js';

const hoisted = vi.hoisted(() => ({ appMounts: 0 }));

vi.mock('../src/ui/App.js', async () => {
  const { useEffect } = await import('react');
  return {
    App: () => {
      useEffect(() => { hoisted.appMounts += 1; }, []);
      return null;
    },
  };
});

const { Root } = await import('../src/ui/Root.js');

let restoreTabStorage: (() => void) | undefined;

function blockTabStorage() {
  restoreTabStorage = refuseTabStorage('blocked');
}

let root: ReactRoot | null = null;

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(element); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/ui/');
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
  forgetEnteredApiToken();
  hoisted.appMounts = 0;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  restoreTabStorage?.();
  restoreTabStorage = undefined;
  vi.restoreAllMocks();
  forgetEnteredApiToken();
  window.sessionStorage.clear();
  delete window.__DKG_TOKEN__;
});

describe('Root', () => {
  it('remounts the dashboard when an entered token could only be kept in memory', async () => {
    await mount(React.createElement(Root));
    expect(hoisted.appMounts).toBe(1);

    blockTabStorage();
    await act(async () => { expect(saveEnteredApiToken('entered-1')).toBe(false); });
    expect(hoisted.appMounts).toBe(2);
  });

  it('leaves the dashboard mounted when the token was kept in tab storage', async () => {
    await mount(React.createElement(Root));
    await act(async () => { expect(saveEnteredApiToken('entered-2')).toBe(true); });
    expect(hoisted.appMounts).toBe(1);
  });
});

describe('useFetch on 401', () => {
  function Probe() {
    const { error } = useFetch(async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    }, []);
    return React.createElement('p', null, error ?? '');
  }

  it('reloads once when the token survives the reload', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    window.__DKG_TOKEN__ = 'served-1';
    await mount(React.createElement(Probe));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('__dkg_401_reloaded')).toBe('1');
  });

  it('does not reload again after the first retry', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    window.__DKG_TOKEN__ = 'served-2';
    window.sessionStorage.setItem('__dkg_401_reloaded', '1');
    const container = await mount(React.createElement(Probe));
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Authentication expired');
  });

  it('never reloads away a token kept only in memory', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    blockTabStorage();
    expect(saveEnteredApiToken('entered-3')).toBe(false);
    const container = await mount(React.createElement(Probe));
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Authentication expired');
  });

  it('does not reload a page-only token even once storage is usable again', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    blockTabStorage();
    expect(saveEnteredApiToken('entered-4')).toBe(false);
    restoreTabStorage?.();
    restoreTabStorage = undefined;
    // Storage works now, but the token was never stored, so a reload would drop it.
    const container = await mount(React.createElement(Probe));
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Authentication expired');
  });

  it('asks for a token when there is none', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const container = await mount(React.createElement(Probe));
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toContain('API token required');
  });
});
