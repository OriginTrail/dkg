/**
 * Web address ⇄ centre tab id. Every tab has an address, so refresh, back,
 * forward and bookmarks all land on the same tab (DESIGN.md · Navigation).
 *
 * Places get short paths; things you open get readable paths with their id.
 * Anything else round-trips through `/open/<encoded tab id>`.
 */
import { PLACES, decodeTabId, type PlaceId } from './tab-target.js';
import { MARKETPLACE_TABS, marketplaceEnabled } from '../marketplace/tabs.js';

export interface TabRoute { id: string; label: string }

const PLACE_BY_PATH = new Map<string, PlaceId>((Object.keys(PLACES) as PlaceId[]).map((id) => [PLACES[id].path, id]));
/** Legacy paths that still land on a place. */
const ALIASES: Record<string, PlaceId> = { '/operations': 'operations' };
/** Marketplace tabs have their own paths; they route only once the section is enabled. */
const MARKETPLACE = Object.values(MARKETPLACE_TABS);
const MARKETPLACE_BY_PATH = new Map<string, (typeof MARKETPLACE)[number]>(MARKETPLACE.map((t) => [t.path, t]));
const MARKETPLACE_BY_ID = new Map<string, (typeof MARKETPLACE)[number]>(MARKETPLACE.map((t) => [t.id, t]));

// Keep ':' readable in paths (it's valid in a path segment).
const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':');
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export function tabIdToPath(id: string): string {
  const market = MARKETPLACE_BY_ID.get(id);
  if (market) return market.path;
  const t = decodeTabId(id);
  switch (t.kind) {
    case 'place': return PLACES[t.id].path;
    case 'graph': return `/graph/${enc(t.contextGraphId)}`;
    case 'conviction': if (/^\d+$/.test(t.accountId)) return `/pca/${t.accountId}`; break;
    case 'agent': return `/agent/${enc(t.contextGraphId)}/${enc(t.slug)}`;
    default: break;
  }
  return `/open/${enc(id)}`;
}

/** The tab a path stands for, or null when the path isn't a tab. */
export function pathToTab(pathname: string): TabRoute | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const place = PLACE_BY_PATH.get(path) ?? ALIASES[path];
  if (place) return { id: place, label: PLACES[place].label };
  const market = MARKETPLACE_BY_PATH.get(path);
  if (market) return marketplaceEnabled() ? { id: market.id, label: market.label } : null;
  let m = /^\/graph\/([^/]+)$/.exec(path);
  if (m) { const cg = dec(m[1]); return { id: `project:${cg}`, label: cg.slice(0, 16) }; }
  m = /^\/pca\/(\d+)$/.exec(path);
  if (m) return { id: `conviction:${m[1]}`, label: `PCA #${m[1]}` };
  m = /^\/agent\/([^/]+)\/([^/]+)$/.exec(path);
  if (m) { const slug = dec(m[2]); return { id: `agent:${dec(m[1])}|${slug}`, label: `@ ${slug.slice(0, 16)}` }; }
  m = /^\/open\/(.+)$/.exec(path);
  if (m) { const id = dec(m[1]); return { id, label: id.split(/[:|]/).pop()?.slice(0, 24) || id }; }
  return null;
}
