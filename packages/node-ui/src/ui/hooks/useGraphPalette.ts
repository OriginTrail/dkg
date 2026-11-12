import { useLayoutStore } from '../stores/layout.js';
import { graphPalette, type GraphPalette } from '../graph-palette.js';

/** The graph palette for the app's current theme; re-renders when it changes.
 *  The one place graph views turn the theme into canvas colours. */
export function useGraphPalette(): GraphPalette {
  return graphPalette(useLayoutStore(s => s.theme));
}
