/**
 * One model of what a centre tab is.
 *
 * Tab ids stay strings so the workspace persists and old ids keep working:
 * `project:<cg>`, `agent:<cg>|<slug>`, `conviction:<n>`, `doc:…` (see
 * doc-tab-id.ts), `wm:<cg>` / `swm:<cg>` / `vm:<cg>`, and a fixed place's
 * own id. Routing (tab-routes.ts), the tab bar's marks (Shell/TabBar.tsx),
 * the centre view dispatch (Shell/PanelCenter.tsx) and the sidebar's Node
 * group all decode ids and look up places here, instead of each parsing the
 * prefixes themselves.
 */
import { DOC_TAB_PREFIX, decodeDocTabId, type DecodedDocTab } from './doc-tab-id.js';

export type PlaceId = 'dashboard' | 'operations' | 'settings' | 'conviction' | 'context-graph-primer' | 'memory-stack';

export interface PlaceMeta {
  /** Web address (tab-routes.ts). */
  path: string;
  /** Tab and sidebar label. */
  label: string;
  /** Tooltip. */
  title: string;
  /** Listed in the sidebar's "Node" group. */
  node?: boolean;
  testId?: string;
}

export const PLACES: Readonly<Record<PlaceId, PlaceMeta>> = {
  dashboard: { path: '/', label: 'Dashboard', title: 'Dashboard' },
  operations: { path: '/observability', label: 'Observability', title: 'Observability: operations, replication, hardware, logs, errors and network', node: true },
  conviction: { path: '/conviction', label: 'Publisher Conviction', title: 'Publisher Conviction: publishing discounts', node: true, testId: 'pca-launch-btn' },
  settings: { path: '/settings', label: 'Settings', title: 'Node settings', node: true },
  'context-graph-primer': { path: '/primer', label: 'What is a context graph?', title: 'What is a context graph?' },
  'memory-stack': { path: '/memory-stack', label: 'Memory stack', title: 'Memory stack' },
};

export const PLACE_IDS = Object.keys(PLACES) as PlaceId[];
/** The sidebar's Node group, in display order. */
export const NODE_PLACE_IDS: readonly PlaceId[] = ['operations', 'conviction', 'settings'];

export function isPlaceId(id: string): id is PlaceId {
  return Object.prototype.hasOwnProperty.call(PLACES, id);
}

export type LayerKey = 'wm' | 'swm' | 'vm';

export type TabTarget =
  | { kind: 'place'; id: PlaceId }
  | { kind: 'graph'; contextGraphId: string }
  | { kind: 'conviction'; accountId: string }
  | { kind: 'agent'; contextGraphId: string; slug: string; agentUri: string }
  | ({ kind: 'document' } & DecodedDocTab)
  | { kind: 'layer'; layer: LayerKey; contextGraphId: string }
  | { kind: 'other'; id: string };

/** Decode a tab id. Never throws: anything unrecognised is `other`. */
export function decodeTabId(id: string): TabTarget {
  if (isPlaceId(id)) return { kind: 'place', id };
  if (id.startsWith('project:')) return { kind: 'graph', contextGraphId: id.slice('project:'.length) };
  if (id.startsWith('conviction:')) return { kind: 'conviction', accountId: id.slice('conviction:'.length) };
  if (id.startsWith('agent:')) {
    // `agent:<contextGraphId>|<agentSlug>`: the graph part scopes the profile
    // to one context graph's data.
    const raw = id.slice('agent:'.length);
    const pipe = raw.indexOf('|');
    if (pipe > 0 && pipe < raw.length - 1) {
      const contextGraphId = raw.slice(0, pipe);
      const slug = raw.slice(pipe + 1);
      return { kind: 'agent', contextGraphId, slug, agentUri: slug.includes(':') ? slug : `urn:dkg:agent:${slug}` };
    }
    return { kind: 'other', id };
  }
  if (id.startsWith(DOC_TAB_PREFIX)) return { kind: 'document', ...decodeDocTabId(id) };
  const layer = /^(wm|swm|vm):(.+)$/.exec(id);
  if (layer) return { kind: 'layer', layer: layer[1] as LayerKey, contextGraphId: layer[2] };
  return { kind: 'other', id };
}

/** The context graph a tab belongs to, if it has one. */
export function tabContextGraphId(id: string): string | null {
  const t = decodeTabId(id);
  switch (t.kind) {
    case 'graph': case 'agent': case 'layer': return t.contextGraphId;
    case 'document': return t.contextGraphId ?? null;
    default: return null;
  }
}
