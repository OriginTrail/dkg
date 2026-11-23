/**
 * The Observability tab lives in the address (`/observability?tab=network`),
 * and the address is its only owner: a refresh, a bookmark, Back and Forward
 * all land on the tab the address names. Open a tab by navigating to
 * `observabilityHref(tab)`; the page reads it with `useObservabilityTab`.
 */
import { PLACES } from './tab-target.js';

const TABS = ['operations', 'replication', 'hardware', 'logs', 'errors', 'network'] as const;
export type ObservabilityTab = (typeof TABS)[number];
const DEFAULT_TAB: ObservabilityTab = 'operations';

/** The tab a query string names, or the default for anything else. */
export function tabFromSearch(search: string): ObservabilityTab {
  const tab = new URLSearchParams(search).get('tab');
  return TABS.find((t) => t === tab) ?? DEFAULT_TAB;
}

/** The query string for a tab, keeping any other values. The default tab leaves `tab` out. */
export function searchForTab(tab: ObservabilityTab, search = ''): string {
  const params = new URLSearchParams(search);
  if (tab === DEFAULT_TAB) params.delete('tab');
  else params.set('tab', tab);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** The address of an Observability tab. */
export function observabilityHref(tab: ObservabilityTab): string {
  return PLACES.operations.path + searchForTab(tab);
}
