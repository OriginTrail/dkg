import { createContext, useContext } from 'react';

/**
 * Whether the side panel around a component is showing. A closed panel stays
 * mounted (so drafts survive) but hidden, and anything it renders outside
 * itself, like a portalled menu, uses this to close along with it.
 */
export const PanelVisibleContext = createContext(true);

export const usePanelVisible = () => useContext(PanelVisibleContext);
