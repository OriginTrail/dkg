// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { useTabsStore, loadPersistedTabs, decodePersistedTab, TABS_STORAGE_KEY, DASHBOARD_TAB } from '../src/ui/stores/tabs.js';
import { pathToTab, tabIdToPath } from '../src/ui/lib/tab-routes.js';

// Tabs behave like browser tabs: saved across refresh, reorderable, closable
// in several ways, reopenable, and every tab has a web address.

const tab = (id: string, label = id) => ({ id, label, closable: true });
const ids = () => useTabsStore.getState().tabs.map((t) => t.id);

beforeEach(() => {
  useTabsStore.setState({ tabs: [DASHBOARD_TAB], activeTabId: 'dashboard', recentlyClosed: [] });
});

describe('tab store', () => {
  it('opens new tabs next to the active one and keeps Dashboard first', () => {
    const s = useTabsStore.getState();
    s.openTab(tab('project:a'));
    s.openTab(tab('project:b'));
    useTabsStore.getState().setActiveTab('project:a');
    useTabsStore.getState().openTab(tab('settings'));
    expect(ids()).toEqual(['dashboard', 'project:a', 'settings', 'project:b']);
    expect(useTabsStore.getState().activeTabId).toBe('settings');
  });

  it('reorders, but never moves anything before the pinned Dashboard', () => {
    const s = useTabsStore.getState();
    ['a', 'b', 'c'].forEach((x) => useTabsStore.getState().openTab(tab(x)));
    s.moveTab('c', 1);
    expect(ids()).toEqual(['dashboard', 'c', 'a', 'b']);
    useTabsStore.getState().moveTab('b', 0);
    expect(ids()[0]).toBe('dashboard');
    useTabsStore.getState().moveTab('dashboard', 3);
    expect(ids()[0]).toBe('dashboard');
  });

  it('closes others and to the right, and remembers what was closed', () => {
    ['a', 'b', 'c', 'd'].forEach((x) => useTabsStore.getState().openTab(tab(x)));
    useTabsStore.getState().closeTabsToRight('b');
    expect(ids()).toEqual(['dashboard', 'a', 'b']);
    useTabsStore.getState().closeOtherTabs('a');
    expect(ids()).toEqual(['dashboard', 'a']);
    expect(useTabsStore.getState().recentlyClosed.map((t) => t.id)).toEqual(['b', 'd', 'c']);
    useTabsStore.getState().closeTab('dashboard');
    expect(ids()).toContain('dashboard');
  });

  it('reopens a recently closed tab', () => {
    useTabsStore.getState().openTab(tab('settings', 'Settings'));
    useTabsStore.getState().closeTab('settings');
    expect(ids()).toEqual(['dashboard']);
    useTabsStore.getState().reopenTab();
    expect(ids()).toEqual(['dashboard', 'settings']);
    expect(useTabsStore.getState().recentlyClosed).toEqual([]);
  });

  it('saves the workspace and restores it, dropping junk safely', () => {
    useTabsStore.getState().openTab(tab('project:a', 'Alpha'));
    useTabsStore.getState().openTab(tab('operations', 'Observability'));
    const saved = localStorage.getItem(TABS_STORAGE_KEY)!;
    const restored = loadPersistedTabs({ getItem: () => saved });
    expect(restored.tabs.map((t) => t.id)).toEqual(['dashboard', 'project:a', 'operations']);
    expect(restored.activeTabId).toBe('operations');
    expect(loadPersistedTabs({ getItem: () => '{not json' }).tabs).toEqual([DASHBOARD_TAB]);
    expect(loadPersistedTabs({ getItem: () => JSON.stringify({ tabs: [{ id: 'x', label: 'X' }, { id: 'x', label: 'X' }, 5], activeTabId: 'gone' }) }))
      .toMatchObject({ tabs: [DASHBOARD_TAB, { id: 'x' }], activeTabId: 'dashboard' });
  });

  it('decodes every saved record into a complete tab, the same way for open and recently closed', () => {
    // The reviewer's record: no closable flag, an object icon.
    expect(decodePersistedTab({ id: 'settings', label: 'Settings', icon: {} })).toEqual({ id: 'settings', label: 'Settings', closable: true });
    expect(decodePersistedTab({ id: 'project:a', label: 'Alpha', icon: 'graph', closable: false })).toEqual({ id: 'project:a', label: 'Alpha', closable: true, icon: 'graph' });
    for (const bad of [null, 5, 'x', [], {}, { id: '', label: 'L' }, { id: 'x' }, { id: 7, label: 'L' }, { id: 'x', label: 3 }, { id: 'dashboard', label: 'Dashboard' }]) {
      expect(decodePersistedTab(bad), JSON.stringify(bad)).toBeNull();
    }
    const saved = JSON.stringify({
      tabs: [{ id: 'b', label: 'B' }, { id: 'a', label: 'A', icon: 1 }, { id: 'dashboard', label: 'Dashboard', closable: true }],
      activeTabId: 'a',
      recentlyClosed: [{ id: 'settings', label: 'Settings', icon: {} }, { id: 'b', label: 'B' }, { id: 'settings', label: 'again' }, { label: 'no id' }],
    });
    const restored = loadPersistedTabs({ getItem: () => saved });
    // Order kept, Dashboard pinned first and not closable.
    expect(restored.tabs).toEqual([DASHBOARD_TAB, { id: 'b', label: 'B', closable: true }, { id: 'a', label: 'A', closable: true }]);
    expect(restored.activeTabId).toBe('a');
    // Recently closed: complete tabs, no open duplicates, no repeats.
    expect(restored.recentlyClosed).toEqual([{ id: 'settings', label: 'Settings', closable: true }]);
    for (const junk of ['null', '[]', '"x"', JSON.stringify({ tabs: 'x', activeTabId: 5, recentlyClosed: {} })]) {
      expect(loadPersistedTabs({ getItem: () => junk }), junk).toEqual({ tabs: [DASHBOARD_TAB], activeTabId: 'dashboard', recentlyClosed: [] });
    }
  });
});

describe('tab addresses', () => {
  it('round-trips every kind of tab', () => {
    for (const id of ['dashboard', 'operations', 'settings', 'conviction', 'context-graph-primer', 'project:cg/with:odd chars',
      'conviction:12', 'agent:my-cg|0xabc', 'doc:cg|urn:dkg:file:keccak256:00ff|text/markdown', 'wm:cg']) {
      expect(pathToTab(tabIdToPath(id))?.id, id).toBe(id);
    }
  });

  it('keeps short paths for places and ignores non-tab pages', () => {
    expect(tabIdToPath('operations')).toBe('/observability');
    expect(pathToTab('/operations')?.id).toBe('operations');
    expect(tabIdToPath('project:abc')).toBe('/graph/abc');
    expect(pathToTab('/network')).toBeNull();
  });
});
