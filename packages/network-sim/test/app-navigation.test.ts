// @vitest-environment happy-dom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { makeStore, mountUi, type MountedUi } from './ui-test-support';
vi.mock('../src/store', () => ({ useStore: () => store, StoreProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../src/components/NetworkGraph', () => ({ NetworkGraph: ({ onSelectNode }: { onSelectNode: (id: number) => void }) => React.createElement('button', { onClick: () => onSelectNode(2) }, 'Select graph node') }));
vi.mock('../src/components/ControlPanel', () => ({ ControlPanel: () => React.createElement('div', null, 'controls') }));
vi.mock('../src/components/ActivityFeed', () => ({ ActivityFeed: () => React.createElement('div', null, 'feed') }));
vi.mock('../src/components/StatsDashboard', () => ({ StatsDashboard: () => React.createElement('div', null, 'stats') }));
let store = makeStore(); let ui: MountedUi;
beforeEach(() => { store = makeStore(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { ui?.unmount(); vi.unstubAllGlobals(); });

describe('app navigation', () => {
  it('keeps simulator mounted while switching pages and forwards graph selections', async () => {
    ui = await mountUi(React.createElement(App));
    expect(ui.container.querySelector('.header-badge')?.textContent).toContain('DEVNET · 2/3 nodes online');
    expect(ui.container.querySelector('.selected-detail')?.textContent).toBe('peer-1... | 2 peers');
    await ui.click('Stats');
    expect((ui.container.querySelector('.graph-area')!.parentElement as HTMLElement).style.display).toBe('none');
    expect((ui.container.querySelector('.stats-page') as HTMLElement).style.display).toBe('');
    await ui.click('Simulator');
    expect((ui.container.querySelector('.stats-page') as HTMLElement).style.display).toBe('none');
    await ui.click('Select graph node'); expect(store.dispatch).toHaveBeenCalledWith({ type: 'SELECT_NODE', id: 2 });
    store.state.networkMode = 'testnet'; store.state.selectedNode = 3;
    await ui.render(React.createElement(App));
    expect(ui.container.querySelector('.header-badge')?.textContent).toContain('TESTNET');
    expect(ui.container.querySelector('.status-dot')?.classList.contains('offline')).toBe(true);
    expect(ui.container.querySelector('.selected-detail')).toBeNull();
    store.state.selectedNode = 99; await ui.render(React.createElement(App));
    expect(ui.container.querySelector('.selected-info')).toBeNull();
  });
  it('renders safe placeholders for an incomplete status response', async () => {
    // The daemon response is not runtime-validated; old versions can omit these fields.
    store.state.nodes[0].status = {} as NonNullable<typeof store.state.nodes[0]['status']>;
    ui = await mountUi(React.createElement(App));
    expect(ui.container.querySelector('.selected-detail')?.textContent).toBe('—... | 0 peers');
  });
});
