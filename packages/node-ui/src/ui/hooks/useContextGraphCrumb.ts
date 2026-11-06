import { useCallback } from 'react';
import type { Crumb } from '../components/ds/Breadcrumbs.js';
import { useProjectsStore } from '../stores/projects.js';
import { useTabsStore } from '../stores/tabs.js';

/** The crumb that opens a Context Graph, named as the sidebar names it. */
export function useContextGraphCrumb(contextGraphId: string): Crumb {
  const name = useProjectsStore((s) => s.contextGraphs.find((cg) => cg.id === contextGraphId)?.name);
  const openTab = useTabsStore((s) => s.openTab);
  const label = name || 'Context Graph';
  const onClick = useCallback(() => {
    openTab({ id: `project:${contextGraphId}`, label, closable: true });
  }, [contextGraphId, label, openTab]);
  return { label, onClick };
}
