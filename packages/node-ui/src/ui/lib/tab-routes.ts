/**
 * Web address ⇄ centre tab id. Every tab has an address, so refresh, back,
 * forward and bookmarks all land on the same tab (DESIGN.md · Navigation).
 *
 * Places get short paths; things you open get readable paths with their id.
 * Anything else round-trips through `/open/<encoded tab id>`.
 */
export interface TabRoute { id: string; label: string }

const PLACES: Record<string, { path: string; label: string }> = {
  dashboard: { path: '/', label: 'Dashboard' },
  operations: { path: '/observability', label: 'Observability' },
  settings: { path: '/settings', label: 'Settings' },
  conviction: { path: '/conviction', label: 'Publisher Conviction' },
  'context-graph-primer': { path: '/primer', label: 'What is a Context Graph?' },
  'memory-stack': { path: '/memory-stack', label: 'Memory stack' },
  'agent-hub': { path: '/agent-hub', label: 'Agent hub' },
};

/** Legacy paths that still land on a place. */
const ALIASES: Record<string, string> = { '/operations': 'operations' };

// Keep ':' readable in paths (it's valid in a path segment).
const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':');
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export function tabIdToPath(id: string): string {
  if (PLACES[id]) return PLACES[id].path;
  if (id.startsWith('project:')) return `/graph/${enc(id.slice('project:'.length))}`;
  if (/^conviction:\d+$/.test(id)) return `/pca/${id.slice('conviction:'.length)}`;
  if (id.startsWith('agent:')) {
    const [cg, slug] = id.slice('agent:'.length).split('|');
    if (cg && slug) return `/agent/${enc(cg)}/${enc(slug)}`;
  }
  return `/open/${enc(id)}`;
}

/** The tab a path stands for, or null when the path isn't a tab (e.g. /network). */
export function pathToTab(pathname: string): TabRoute | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const [id, p] of Object.entries(PLACES)) if (p.path === path) return { id, label: p.label };
  if (ALIASES[path]) return { id: ALIASES[path], label: PLACES[ALIASES[path]].label };
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
