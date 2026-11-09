// @vitest-environment happy-dom

/**
 * The shell's status poll, driven through real requests: failed checks add
 * up to Unavailable, a 401 clears the count because the node answered, and a
 * good check brings the status back.
 */
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { NODE_STATUS_POLL_MS, NODE_UNAVAILABLE_AFTER_FAILURES } from '../src/ui/lib/nodeStatusPolicy.js';
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

  it('keeps counting under Strict Mode, which runs effects twice', async () => {
    let answer: () => Promise<unknown> = up;
    fetchStatusMock.mockImplementation(() => answer());
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(React.StrictMode, null, React.createElement(StatusWord)));
    });
    expect(container.textContent).toBe('Connected');

    answer = down;
    for (let i = 0; i < NODE_UNAVAILABLE_AFTER_FAILURES; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(NODE_STATUS_POLL_MS); });
    }
    expect(container.textContent).toBe('Unavailable');

    answer = up;
    await act(async () => { await vi.advanceTimersByTimeAsync(NODE_STATUS_POLL_MS); });
    expect(container.textContent).toBe('Connected');
  });

  it('ignores older failed checks that finish after a newer good one', async () => {
    const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    fetchStatusMock.mockImplementation(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    await act(async () => { root = createRoot(container); root.render(React.createElement(StatusWord)); });
    // Four checks in flight: the mount, then three more ticks.
    for (let i = 0; i < NODE_UNAVAILABLE_AFTER_FAILURES; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(NODE_STATUS_POLL_MS); });
    }
    expect(pending).toHaveLength(NODE_UNAVAILABLE_AFTER_FAILURES + 1);

    await act(async () => { pending.at(-1)!.resolve({ connectedPeers: 2 }); });
    expect(container.textContent).toBe('Connected');
    await act(async () => { for (const p of pending.slice(0, -1)) p.reject({ status: 503 }); });
    expect(useAgentsStore.getState().nodeStatusFailures).toBe(0);
    expect(container.textContent).toBe('Connected');
  });

  describe('through the real status request', () => {
    // A hung node never answers. Each request stays open until its deadline
    // aborts it, which the fake clock drives here.
    beforeEach(async () => {
      const { fetchStatus } = await vi.importActual<typeof import('../src/ui/api.js')>('../src/ui/api.js');
      fetchStatusMock.mockImplementation(fetchStatus);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
        return controller.signal;
      });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    let answer = false;
    // Without a deadline the request would simply never settle.
    const fetchStub = (_url: string, init: RequestInit = {}) => answer
      ? Promise.resolve(new Response(JSON.stringify({ connectedPeers: 4 }), { status: 200 }))
      : new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));

    it('counts stalled checks as failures, then recovers when the node answers', async () => {
      answer = false;
      vi.stubGlobal('fetch', vi.fn(fetchStub));
      await act(async () => { root = createRoot(container); root.render(React.createElement(StatusWord)); });
      // Each check times out as the next one starts, so the count trails by one.
      for (let i = 0; i < NODE_UNAVAILABLE_AFTER_FAILURES; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(NODE_STATUS_POLL_MS); });
      }
      expect(useAgentsStore.getState().nodeStatusFailures).toBeGreaterThanOrEqual(NODE_UNAVAILABLE_AFTER_FAILURES);
      expect(container.textContent).toBe('Unavailable');

      answer = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(NODE_STATUS_POLL_MS); });
      expect(container.textContent).toBe('Connected');
    });
  });
});
