// @vitest-environment happy-dom
// Graph views get their palette from the theme in the layout store and
// re-render with the other palette when the theme changes.
import React, { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { useGraphPalette } from '../src/ui/hooks/useGraphPalette.js';
import { graphPalette, type GraphPalette } from '../src/ui/graph-palette.js';
import { useLayoutStore } from '../src/ui/stores/layout.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useGraphPalette', () => {
  it('follows the layout store theme', async () => {
    const seen: GraphPalette[] = [];
    function Probe() {
      seen.push(useGraphPalette());
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => { useLayoutStore.getState().setTheme('dark'); });
    await act(async () => { root.render(React.createElement(Probe)); });
    expect(seen.at(-1)).toBe(graphPalette('dark'));
    await act(async () => { useLayoutStore.getState().setTheme('light'); });
    expect(seen.at(-1)).toBe(graphPalette('light'));
    await act(async () => { root.unmount(); });
    useLayoutStore.getState().setTheme('dark');
  });
});
