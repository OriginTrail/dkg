// @vitest-environment happy-dom
// openRight is the one action that opens the agents panel for the screen it's on: floating
// on a narrow screen, docked otherwise, and with expandOnDesktop expanded over the centre on
// a wide one, in a single update. Opening twice changes nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { useLayoutStore } from '../src/ui/stores/layout.js';

function setNarrow(narrow: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes('max-width'),
    media: query,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    onchange: null, dispatchEvent: () => false,
  })) as never;
}

/** The store updates an action makes. */
function updates(run: () => void): number {
  let n = 0;
  const stop = useLayoutStore.subscribe(() => { n++; });
  run();
  stop();
  return n;
}

const panel = () => {
  const { rightCollapsed, rightExpanded, narrowPanel } = useLayoutStore.getState();
  return { rightCollapsed, rightExpanded, narrowPanel };
};

describe('openRight', () => {
  afterEach(() => useLayoutStore.setState({ rightCollapsed: false, rightExpanded: false, narrowPanel: null }));

  it('opens and expands a collapsed panel in one update on a wide screen', () => {
    setNarrow(false);
    useLayoutStore.setState({ rightCollapsed: true, rightExpanded: false, narrowPanel: null });
    expect(updates(() => useLayoutStore.getState().openRight({ expandOnDesktop: true }))).toBe(1);
    expect(panel()).toEqual({ rightCollapsed: false, rightExpanded: true, narrowPanel: null });
    expect(updates(() => useLayoutStore.getState().openRight({ expandOnDesktop: true }))).toBe(0);
  });

  it('expands a panel that is already docked open', () => {
    setNarrow(false);
    useLayoutStore.setState({ rightCollapsed: false, rightExpanded: false, narrowPanel: null });
    useLayoutStore.getState().openRight({ expandOnDesktop: true });
    expect(panel().rightExpanded).toBe(true);
  });

  it('only docks the panel open without expandOnDesktop', () => {
    setNarrow(false);
    useLayoutStore.setState({ rightCollapsed: true, rightExpanded: false, narrowPanel: null });
    useLayoutStore.getState().openRight();
    expect(panel()).toEqual({ rightCollapsed: false, rightExpanded: false, narrowPanel: null });
    expect(updates(() => useLayoutStore.getState().openRight())).toBe(0);
  });

  it('floats the panel on a narrow screen and never expands it there', () => {
    setNarrow(true);
    useLayoutStore.setState({ rightCollapsed: true, rightExpanded: false, narrowPanel: null });
    expect(updates(() => useLayoutStore.getState().openRight({ expandOnDesktop: true }))).toBe(1);
    expect(panel()).toEqual({ rightCollapsed: true, rightExpanded: false, narrowPanel: 'right' });
  });
});
