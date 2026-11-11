// @vitest-environment happy-dom
//
// The centre tab bar's own interactions, driven through the rendered
// component and the real tabs store (review: tests-navigation.test.ts only
// calls store actions, so it can't catch a disconnected handler).
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { TabBar } from '../src/ui/components/Shell/TabBar.js';
import { DASHBOARD_TAB, useTabsStore, type CenterTab } from '../src/ui/stores/tabs.js';
import { useProjectsStore } from '../src/ui/stores/projects.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: string, label: string): CenterTab => ({ id, label, closable: true });
const A = tab('settings', 'Settings');
const B = tab('operations', 'Observability');
const C = tab('project:alpha', 'Alpha');

let root: Root;
let container: HTMLDivElement;

const tabEls = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const titles = () => tabEls().map(t => t.getAttribute('title'));
const tabEl = (title: string) => tabEls().find(t => t.getAttribute('title') === title)!;
const store = () => useTabsStore.getState();
const frame = () => new Promise(r => setTimeout(r, 20));

function fire(el: Element, type: string, init: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const Ctor = type.startsWith('key') ? KeyboardEvent : MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(event, k, { value: v });
  act(() => { el.dispatchEvent(event); });
}
const dataTransfer = () => ({ effectAllowed: '', setData() {}, getData() { return ''; } });

beforeEach(() => {
  useProjectsStore.setState({ contextGraphs: [{ id: 'alpha', name: 'Alpha' } as any] });
  useTabsStore.setState({ tabs: [DASHBOARD_TAB, A, B, C], activeTabId: A.id, recentlyClosed: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(TabBar)); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('TabBar', () => {
  it('shows a graph tab under its current name from the inventory, with the saved label as fallback', () => {
    // The saved label is a short id until the graph list loads; the sidebar need not be mounted.
    act(() => { useTabsStore.setState({ tabs: [DASHBOARD_TAB, tab('project:beta', 'beta'), tab('project:gamma', 'gamma')], activeTabId: 'project:beta' }); });
    act(() => { useProjectsStore.setState({ contextGraphs: [{ id: 'beta', name: 'Beta Research' } as any] }); });
    expect(titles()).toEqual(['Dashboard', 'Beta Research', 'gamma']);
    expect(tabEl('Beta Research').querySelector('[aria-label="Close Beta Research"]')).not.toBeNull();
    act(() => { container.querySelector<HTMLElement>('.v10-center-tabs-all')!.click(); });
    expect([...container.querySelectorAll('.v10-tab-menu-text')].map(e => e.textContent)).toContain('Beta Research');
  });

  it('pins Dashboard first: icon-only, no close button, not draggable', () => {
    expect(titles()).toEqual(['Dashboard', 'Settings', 'Observability', 'Alpha']);
    const dash = tabEl('Dashboard');
    expect(dash.classList.contains('pinned')).toBe(true);
    expect(dash.getAttribute('draggable')).toBe('false');
    expect(dash.querySelector('.v10-center-tab-close')).toBeNull();
    expect(dash.querySelector('.v10-center-tab-label')).toBeNull();
    expect(tabEl('Alpha').querySelector('[aria-label="Close Alpha"]')).not.toBeNull();
  });

  it('reorders by drag and drop, before or after the target, and never past Dashboard', () => {
    // Drop Alpha on the left half of Settings → before it.
    fire(tabEl('Alpha'), 'dragstart', {}, { dataTransfer: dataTransfer() });
    fire(tabEl('Settings'), 'dragover', { clientX: -1 }, { dataTransfer: dataTransfer() });
    fire(tabEl('Settings'), 'drop', { clientX: -1 }, { dataTransfer: dataTransfer() });
    expect(titles()).toEqual(['Dashboard', 'Alpha', 'Settings', 'Observability']);

    // Drop Alpha on the right half of Settings → just after it (the index
    // adjusts for Alpha's own removal; a middle target, so no end clamp hides it).
    fire(tabEl('Alpha'), 'dragstart', {}, { dataTransfer: dataTransfer() });
    fire(tabEl('Settings'), 'dragover', { clientX: 10_000 }, { dataTransfer: dataTransfer() });
    fire(tabEl('Settings'), 'drop', { clientX: 10_000 }, { dataTransfer: dataTransfer() });
    expect(titles()).toEqual(['Dashboard', 'Settings', 'Alpha', 'Observability']);
    fire(tabEl('Alpha'), 'dragstart', {}, { dataTransfer: dataTransfer() });
    fire(tabEl('Observability'), 'dragover', { clientX: 10_000 }, { dataTransfer: dataTransfer() });
    fire(tabEl('Observability'), 'drop', { clientX: 10_000 }, { dataTransfer: dataTransfer() });
    expect(titles()).toEqual(['Dashboard', 'Settings', 'Observability', 'Alpha']);

    // Dashboard is not a drop target.
    fire(tabEl('Alpha'), 'dragstart', {}, { dataTransfer: dataTransfer() });
    fire(tabEl('Dashboard'), 'dragover', { clientX: -1 }, { dataTransfer: dataTransfer() });
    fire(tabEl('Dashboard'), 'drop', { clientX: -1 }, { dataTransfer: dataTransfer() });
    expect(titles()[0]).toBe('Dashboard');
    expect(titles()).toEqual(['Dashboard', 'Settings', 'Observability', 'Alpha']);
  });

  it('moves selection with ←/→ and focuses the new active tab', async () => {
    fire(tabEl('Settings'), 'keydown', { key: 'ArrowRight' });
    expect(store().activeTabId).toBe(B.id);
    await act(frame);
    expect(document.activeElement?.getAttribute('title')).toBe('Observability');
    fire(tabEl('Observability'), 'keydown', { key: 'ArrowLeft' });
    fire(tabEl('Settings'), 'keydown', { key: 'ArrowLeft' });
    expect(store().activeTabId).toBe('dashboard');
  });

  it('moves a tab with Ctrl+Shift+←/→ and closes it with Delete, but not Dashboard', () => {
    fire(tabEl('Alpha'), 'keydown', { key: 'ArrowLeft', ctrlKey: true, shiftKey: true });
    expect(titles()).toEqual(['Dashboard', 'Settings', 'Alpha', 'Observability']);
    fire(tabEl('Alpha'), 'keydown', { key: 'Delete' });
    expect(titles()).toEqual(['Dashboard', 'Settings', 'Observability']);
    fire(tabEl('Dashboard'), 'keydown', { key: 'Delete' });
    expect(titles()).toContain('Dashboard');
  });

  it('closes a tab with a middle click, but not Dashboard', () => {
    fire(tabEl('Observability'), 'auxclick', { button: 1 });
    expect(titles()).toEqual(['Dashboard', 'Settings', 'Alpha']);
    fire(tabEl('Dashboard'), 'auxclick', { button: 1 });
    expect(titles()[0]).toBe('Dashboard');
  });

  it('closes others from the context menu, then reopens from Recently closed', () => {
    fire(tabEl('Observability'), 'contextmenu', { clientX: 10, clientY: 10 });
    const closeOthers = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(b => b.textContent === 'Close others')!;
    act(() => { closeOthers.click(); });
    expect(titles()).toEqual(['Dashboard', 'Observability']);
    expect(container.querySelector('[role="menu"]')).toBeNull();

    act(() => { container.querySelector<HTMLElement>('.v10-center-tabs-all')!.click(); });
    const reopen = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(b => b.textContent?.startsWith('Alpha') && b.textContent.endsWith('reopen'))!;
    expect(reopen).toBeTruthy();
    act(() => { reopen.click(); });
    expect(titles()).toContain('Alpha');
    expect(store().activeTabId).toBe(C.id);
  });
});
