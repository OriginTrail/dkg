// @vitest-environment happy-dom
// The expanded right panel covers the centre, so any navigation has to bring it back,
// including to the tab that's already open.
import { beforeEach, describe, expect, it } from 'vitest';
import { useLayoutStore } from '../src/ui/stores/layout.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';

describe('expanded right panel', () => {
  beforeEach(() => useLayoutStore.getState().setRightExpanded(true));

  it('collapses when a tab opens', () => {
    useTabsStore.getState().openTab({ id: 'settings', label: 'Settings', closable: true });
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  it('collapses when the active tab is chosen again', () => {
    useTabsStore.getState().setActiveTab(useTabsStore.getState().activeTabId);
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });

  it('collapses when the panel closes', () => {
    useLayoutStore.getState().toggleRight();
    expect(useLayoutStore.getState().rightExpanded).toBe(false);
  });
});
