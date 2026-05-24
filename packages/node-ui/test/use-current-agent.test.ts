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
    fetchCurrentAgentMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('clears cached identity when a refresh fails', async () => {
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
});
