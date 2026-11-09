import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, vi } from 'vitest';
import type { useStore } from '../src/store';

export function makeStore(): ReturnType<typeof useStore> {
  return {
    state: {
      nodes: [1, 2, 3].map(id => ({ id, name: `devnet-node-${id}`, apiPort: 9200 + id, listenPort: 10000 + id,
        nodeRole: id === 1 ? 'core' as const : 'edge' as const, online: id !== 3,
        status: id === 3 ? null : { name: `node-${id}`, peerId: `peer-${id}`, nodeRole: 'edge' as const, uptimeMs: 1000, connectedPeers: 2, connections: 2, relayConnected: true, multiaddrs: [] } })),
      selectedNode: 1, activities: [], animations: [], config: null, configError: null,
      liveMetrics: { total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] },
      simulationRuns: [], activeSimulationId: null, networkMode: 'devnet',
    },
    dispatch: vi.fn(), addOperation: vi.fn(() => 'operation'), addBroadcast: vi.fn(() => 'broadcast'), completeOperation: vi.fn(),
  };
}

export async function mountUi(node: ReactNode) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  await act(async () => root.render(node));
  return {
    container,
    async render(next: ReactNode) { await act(async () => root.render(next)); },
    unmount() { if (!mounted) return; mounted = false; act(() => root.unmount()); container.remove(); },
    button(text: string, scope: ParentNode = container) {
      const button = Array.from(scope.querySelectorAll('button')).find(b => b.textContent?.trim() === text);
      expect(button, `button ${text}`).toBeDefined(); return button!;
    },
    async click(text: string, scope: ParentNode = container) {
      await act(async () => this.button(text, scope).click());
    },
    field(label: string) {
      const group = Array.from(container.querySelectorAll('.form-group')).find(g => g.querySelector('label')?.textContent === label);
      const field = group?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea');
      expect(field, `field ${label}`).toBeTruthy(); return field!;
    },
    async fill(label: string, value: string) {
      const field = this.field(label);
      const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    },
  };
}
export type MountedUi = Awaited<ReturnType<typeof mountUi>>;
