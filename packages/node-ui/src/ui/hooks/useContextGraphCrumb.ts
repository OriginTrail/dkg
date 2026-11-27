import { useCallback } from 'react';
import type { Crumb } from '../components/ds/Breadcrumbs.js';
import { useProjectsStore } from '../stores/projects.js';
import { chooseTab as openTab } from '../lib/shellNavigation.js';

/** The crumb that opens a Context Graph, named as the sidebar names it. */
export function useContextGraphCrumb(contextGraphId: string): Crumb {
  const name = useProjectsStore((s) => s.contextGraphs.find((cg) => cg.id === contextGraphId)?.name);
  const label = name || 'Context graph';
  const onClick = useCallback(() => {
    openTab({ id: `project:${contextGraphId}`, label, closable: true });
  }, [contextGraphId, label, openTab]);
  return { label, onClick };
}
