// @vitest-environment happy-dom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardSessionGate } from '../src/ui/components/DashboardSessionGate.js';
import { daemonFetch } from '../src/ui/dashboardSessionClient.js';
import { resetDashboardSession, useAuthenticatedDashboardSession } from './helpers/dashboard-session.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ProtectedProbe() {
  useEffect(() => {
    void daemonFetch('/api/status');
  }, []);

  return React.createElement('div', { 'data-testid': 'protected-probe' });
}

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('DashboardSessionGate', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let statusBody: unknown;
  let resolveExchange: ((response: Response) => void) | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    calls.length = 0;
    statusBody = { authenticated: false };
    resolveExchange = undefined;
    resetDashboardSession();
    const exchangeResponse = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === '/api/dashboard/session/status') {
        return new Response(JSON.stringify(statusBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/dashboard/session/loopback') {
        return new Response(JSON.stringify({ error: 'Loopback dashboard session is only available from localhost' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/dashboard/session/exchange') {
        return exchangeResponse;
      }
      if (url === '/api/status') {
        return new Response(JSON.stringify({ synced: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container.remove();
    vi.unstubAllGlobals();
    useAuthenticatedDashboardSession();
  });

  it('requires dashboard username/password sign-in before protected API calls run', async () => {
    await act(async () => {
      root!.render(React.createElement(DashboardSessionGate, null, React.createElement(ProtectedProbe)));
    });
    await flush();

    expect(container.querySelector('[data-testid="dashboard-session-unlock"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="protected-probe"]')).toBeNull();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/dashboard/session/status',
    ]);

    expect(container.textContent).toContain('Sign in to DKG Node Dashboard');
    expect(container.textContent).toContain("using this daemon's DKG_HOME");
    const usernameInput = container.querySelector('input[type="text"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    const form = container.querySelector('form') as HTMLFormElement | null;
    if (!usernameInput || !passwordInput || !form) throw new Error('login form missing');
    expect(usernameInput.value).toBe('node-admin');

    await act(async () => {
      setInputValue(passwordInput, 'secret-password');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    const exchange = calls.find((call) => call.url === '/api/dashboard/session/exchange');
    expect(exchange?.method).toBe('POST');
    expect(exchange?.body).toBe(JSON.stringify({ username: 'node-admin', password: 'secret-password' }));

    await act(async () => {
      resolveExchange?.(new Response(JSON.stringify({
        authenticated: true,
        source: 'login',
        csrfToken: 'csrf-remote',
        expiresAt: Date.now() + 60_000,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(container.querySelector('[data-testid="dashboard-session-unlock"]')).toBeNull();
    expect(container.querySelector('[data-testid="protected-probe"]')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/status')).toBe(true);
  });

  it('keeps the login gate active and re-enables submit after failed credentials', async () => {
    await act(async () => {
      root!.render(React.createElement(DashboardSessionGate, null, React.createElement(ProtectedProbe)));
    });
    await flush();

    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    const form = container.querySelector('form') as HTMLFormElement | null;
    if (!passwordInput || !form) throw new Error('login form missing');

    await act(async () => {
      setInputValue(passwordInput, 'wrong-password');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    const exchange = calls.find((call) => call.url === '/api/dashboard/session/exchange');
    expect(exchange?.method).toBe('POST');
    expect(exchange?.body).toBe(JSON.stringify({ username: 'node-admin', password: 'wrong-password' }));

    await act(async () => {
      resolveExchange?.(new Response(JSON.stringify({
        error: 'Invalid dashboard username or password',
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(alert?.textContent).toContain('Invalid dashboard username or password');
    expect(submit?.disabled).toBe(false);
    expect(submit?.textContent).toBe('Sign in');
    expect(container.querySelector('[data-testid="dashboard-session-unlock"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="protected-probe"]')).toBeNull();
    expect(calls.some((call) => call.url === '/api/status')).toBe(false);
  });

  it('allows auth-disabled dashboards without unlock or loopback bootstrap', async () => {
    statusBody = { authenticated: true, authDisabled: true };

    await act(async () => {
      root!.render(React.createElement(DashboardSessionGate, null, React.createElement(ProtectedProbe)));
    });
    await flush();

    expect(container.querySelector('[data-testid="dashboard-session-unlock"]')).toBeNull();
    expect(container.querySelector('[data-testid="protected-probe"]')).toBeTruthy();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/dashboard/session/status',
      'GET /api/status',
    ]);
  });
});
