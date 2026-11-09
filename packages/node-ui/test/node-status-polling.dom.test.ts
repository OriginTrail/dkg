// @vitest-environment happy-dom

/**
 * The shell's status poll, driven through real requests: failed checks add
 * up to Unavailable, a 401 clears the count because the node answered, and a
 * good check brings the status back.
 */
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { NODE_STATUS_POLL_MS, NODE_UNAVAILABLE_AFTER_FAILURES } from '../src/ui/lib/formatPeerStatus.js';
import { useAgentsStore } from '../src/ui/stores/agents.js';

const fetchStatusMock = vi.fn();
vi.mock('../src/ui/api-wrapper.js', () => ({ api: { fetchStatus: fetchStatusMock } }));

const { useNodeState, useNodeStatusPolling } = await import('../src/ui/hooks/useNodeState.js');

function StatusWord() {
  useNodeStatusPolling();
  return React.createElement('span', null, useNodeState().state.word);
}

const down = () => Promise.reject({ status: 503 });
const unauthorised = () => Promise.reject({ status: 401 });
const up = () => Promise.resolve({ connectedPeers: 3 });

describe('node status polling', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    fetchStatusMock.mockReset();
    useAgentsStore.setState({ nodeStatus: null, nodeStatusFailures: 0 });
    container = document.createElement('div');
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.useRealTimers();
  });

  /** Mount (the first check), then run one more check per remaining response. */
  async function poll(...responses: Array<() => Promise<unknown>>) {
    for (const r of responses) fetchStatusMock.mockImplementationOnce(r);
    await act(async () => { root = createRoot(container); root.render(React.createElement(StatusWord)); });
    for (let i = 1; i < responses.length; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(NODE_STATUS_POLL_MS); });
    }
    return container.textContent;
  }

  it('says Unavailable after enough failed checks in a row', async () => {
    const word = await poll(up, ...Array(NODE_UNAVAILABLE_AFTER_FAILURES).fill(down));
    expect(word).toBe('Unavailable');
  });

  it('clears the count on a 401, so failures either side of it never add up', async () => {
    const before = Array(NODE_UNAVAILABLE_AFTER_FAILURES - 1).fill(down);
    const word = await poll(up, ...before, unauthorised, down);
    expect(useAgentsStore.getState().nodeStatusFailures).toBe(1);
    expect(word).toBe('Connected');
  });

  it('recovers on the next good check', async () => {
    const word = await poll(up, ...Array(NODE_UNAVAILABLE_AFTER_FAILURES).fill(down), up);
    expect(useAgentsStore.getState().nodeStatusFailures).toBe(0);
    expect(word).toBe('Connected');
  });
});
