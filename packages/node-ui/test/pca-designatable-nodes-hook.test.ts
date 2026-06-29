// @vitest-environment happy-dom
//
// M7 — useDesignatableNodes: the multi-page cursor-follow, the byStakeDesc client sort (BigInt +
// non-numeric catch→0), and the L11 stop-at-`total` (no magic page cap). Mocks listDesignatableNodes.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listDesignatableNodes: vi.fn() }));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, listDesignatableNodes: mocks.listDesignatableNodes };
});

const { useDesignatableNodes } = await import('../src/ui/hooks/useDesignatableNodes.js');
import type { UseDesignatableNodes } from '../src/ui/hooks/useDesignatableNodes.js';

let latest: UseDesignatableNodes | null = null;
function Harness() {
  latest = useDesignatableNodes();
  return null;
}

async function renderHook() {
  latest = null;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(React.createElement(Harness)); });
  for (let i = 0; i < 100 && (latest == null || latest.loading); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  return { unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('useDesignatableNodes', () => {
  it('follows the offset cursor across pages and sorts by stake DESC', async () => {
    mocks.listDesignatableNodes.mockImplementation(async (opts?: { start?: number }) => {
      const start = opts?.start ?? 0;
      if (start === 0) return { nodes: [{ nodeId: 'a', identityId: '1', stake: '30' }], total: 3, nextStart: 1 };
      if (start === 1) return { nodes: [{ nodeId: 'b', identityId: '2', stake: '90' }], total: 3, nextStart: 2 };
      return { nodes: [{ nodeId: 'c', identityId: '3', stake: '10' }], total: 3, nextStart: null };
    });
    const { unmount } = await renderHook();
    expect(mocks.listDesignatableNodes).toHaveBeenCalledTimes(3);
    expect(latest!.nodes.map((n) => n.identityId)).toEqual(['2', '1', '3']); // 90, 30, 10
    expect(latest!.error).toBe(false);
    await unmount();
  });

  it('non-numeric stake → byStakeDesc leaves order (no throw)', async () => {
    mocks.listDesignatableNodes.mockResolvedValue({
      nodes: [{ nodeId: 'a', identityId: '1', stake: 'not-a-number' }, { nodeId: 'b', identityId: '2', stake: '5' }],
      total: 2, nextStart: null,
    });
    const { unmount } = await renderHook();
    expect(latest!.nodes).toHaveLength(2); // did not throw
    await unmount();
  });

  it('L11 — stops once it has collected `total`, even if nextStart is non-null', async () => {
    mocks.listDesignatableNodes.mockImplementation(async (opts?: { start?: number }) =>
      (opts?.start ?? 0) === 0
        ? { nodes: [{ nodeId: 'a', identityId: '1', stake: '1' }, { nodeId: 'b', identityId: '2', stake: '2' }], total: 2, nextStart: 2 }
        : { nodes: [{ nodeId: 'c', identityId: '3', stake: '3' }], total: 2, nextStart: null },
    );
    const { unmount } = await renderHook();
    expect(latest!.nodes).toHaveLength(2);
    expect(mocks.listDesignatableNodes).toHaveBeenCalledTimes(1); // stopped at total (no extra page)
    await unmount();
  });

  it('surfaces a read failure as error (retryable)', async () => {
    mocks.listDesignatableNodes.mockRejectedValue(new Error('SHARDING_TABLE_READ_FAILED'));
    const { unmount } = await renderHook();
    expect(latest!.error).toBe(true);
    expect(latest!.nodes).toEqual([]);
    await unmount();
  });
});
