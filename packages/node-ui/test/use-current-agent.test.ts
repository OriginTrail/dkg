// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCurrentAgentMock = vi.fn();

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchCurrentAgent: () => fetchCurrentAgentMock(),
  },
}));

const { useCurrentAgent } = await import('../src/ui/hooks/useCurrentAgent.js');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Probe() {
  const currentAgent = useCurrentAgent();
  return React.createElement('div', {
    'data-agent-did': currentAgent.data?.agentDid ?? '',
    'data-loading': String(currentAgent.loading),
    'data-error': currentAgent.error ?? '',
  });
}

describe('useCurrentAgent', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as any).__DKG_TOKEN__ = 'token-old';
    fetchCurrentAgentMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).__DKG_TOKEN__;
    document.body.innerHTML = '';
  });

  it('preserves identity on transient failure but clears it when auth changes', async () => {
    fetchCurrentAgentMock.mockResolvedValueOnce({
      agentDid: 'did:dkg:agent:0xold',
      agentAddress: '0xold',
      name: 'Old agent',
      framework: 'DKG',
      peerId: 'peer-old',
      nodeIdentityId: '0',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('did:dkg:agent:0xold');

    fetchCurrentAgentMock.mockRejectedValueOnce(new Error('temporary failure'));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('did:dkg:agent:0xold');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('false');
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('temporary failure');

    (window as any).__DKG_TOKEN__ = 'token-new';
    fetchCurrentAgentMock.mockRejectedValueOnce(new Error('auth failed'));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('false');
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('auth failed');

    await act(async () => root.unmount());
  });

  it('starts a new identity fetch when auth changes during a pending load', async () => {
    const oldLoad = deferred<any>();
    const newLoad = deferred<any>();
    fetchCurrentAgentMock
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(1);

    (window as any).__DKG_TOKEN__ = 'token-new';
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(2);
    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('true');

    await act(async () => {
      newLoad.resolve({
        agentDid: 'did:dkg:agent:0xnew',
        agentAddress: '0xnew',
        name: 'New agent',
        framework: 'DKG',
        peerId: 'peer-new',
        nodeIdentityId: '0',
      });
      await newLoad.promise;
      await Promise.resolve();
    });

    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('did:dkg:agent:0xnew');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('false');

    await act(async () => {
      oldLoad.resolve({
        agentDid: 'did:dkg:agent:0xold',
        agentAddress: '0xold',
        name: 'Old agent',
        framework: 'DKG',
        peerId: 'peer-old',
        nodeIdentityId: '0',
      });
      await oldLoad.promise;
      await Promise.resolve();
    });
    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('did:dkg:agent:0xnew');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('false');

    await act(async () => root.unmount());
  });

  it('starts a replacement load when a pending request detects auth changed', async () => {
    const oldLoad = deferred<any>();
    const newLoad = deferred<any>();
    fetchCurrentAgentMock
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(1);

    (window as any).__DKG_TOKEN__ = 'token-new';
    await act(async () => {
      oldLoad.resolve({
        agentDid: 'did:dkg:agent:0xold',
        agentAddress: '0xold',
        name: 'Old agent',
        framework: 'DKG',
        peerId: 'peer-old',
        nodeIdentityId: '0',
      });
      await oldLoad.promise;
      await Promise.resolve();
    });

    expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(2);
    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('true');

    await act(async () => {
      newLoad.resolve({
        agentDid: 'did:dkg:agent:0xnew',
        agentAddress: '0xnew',
        name: 'New agent',
        framework: 'DKG',
        peerId: 'peer-new',
        nodeIdentityId: '0',
      });
      await newLoad.promise;
      await Promise.resolve();
    });

    expect(container.firstElementChild?.getAttribute('data-agent-did')).toBe('did:dkg:agent:0xnew');
    expect(container.firstElementChild?.getAttribute('data-loading')).toBe('false');

    await act(async () => root.unmount());
  });

  it('loads immediately for a new consumer after auth changes while polling is active', async () => {
    fetchCurrentAgentMock.mockResolvedValueOnce({
      agentDid: 'did:dkg:agent:0xold',
      agentAddress: '0xold',
      name: 'Old agent',
      framework: 'DKG',
      peerId: 'peer-old',
      nodeIdentityId: '0',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(1);

    fetchCurrentAgentMock.mockResolvedValueOnce({
      agentDid: 'did:dkg:agent:0xnew',
      agentAddress: '0xnew',
      name: 'New agent',
      framework: 'DKG',
      peerId: 'peer-new',
      nodeIdentityId: '0',
    });

    (window as any).__DKG_TOKEN__ = 'token-new';
    await act(async () => {
      root.render(React.createElement(React.Fragment, {},
        React.createElement(Probe),
        React.createElement(Probe),
      ));
      await Promise.resolve();
    });

    expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-agent-did="did:dkg:agent:0xnew"]')).toBeTruthy();

    await act(async () => root.unmount());
  });
});
