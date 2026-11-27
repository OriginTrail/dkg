/**
 * Context graph identity colour.
 *
 * Every place that names a context graph (sidebar, tab, header strip,
 * memory stack, dashboard list, chat picker) shows the same colour, so the
 * colour tells you which graph you are working in.
 *
 * Colours come from the 8-slot data palette (--data-1 … --data-8 in
 * styles/00-theme.css), which is kept clear of the layer hues (WM slate,
 * SWM cyan, VM purple) and the signal hues. The colour is derived from the
 * graph's id, so it needs no server field and is the same on every screen,
 * on every visit:
 *   - ids are processed in sorted order;
 *   - each id starts at the slot its hash prefers and probes forward to the
 *     first free slot, so up to 8 graphs never share a colour;
 *   - from the 9th graph on, colours repeat (hash slot, no probing).
 */
import { createElement } from 'react';
import { decodeTabId } from './lib/tab-target.js';
import { useProjectsStore } from './stores/projects.js';

export const CONTEXT_GRAPH_SLOTS = 8;

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic slot (1-based) for every id in the set. Pure; exported for tests. */
export function assignContextGraphSlots(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of [...new Set(ids)].sort()) {
    const preferred = hashId(id) % CONTEXT_GRAPH_SLOTS;
    let slot = preferred;
    if (taken.size < CONTEXT_GRAPH_SLOTS) {
      for (let probe = 0; probe < CONTEXT_GRAPH_SLOTS; probe++) {
        const candidate = (preferred + probe) % CONTEXT_GRAPH_SLOTS;
        if (!taken.has(candidate)) { slot = candidate; break; }
      }
      taken.add(slot);
    }
    out.set(id, slot + 1);
  }
  return out;
}

export function contextGraphColorVar(slot: number): string {
  return `var(--data-${slot})`;
}

/** Colour for one id within a known set of ids (falls back to the hash slot). */
export function contextGraphColor(id: string, allIds: readonly string[]): string {
  const slot = assignContextGraphSlots(allIds.includes(id) ? allIds : [...allIds, id]).get(id)
    ?? (hashId(id) % CONTEXT_GRAPH_SLOTS) + 1;
  return contextGraphColorVar(slot);
}

/** Ids from the store's graph list; tolerant of a missing or partial list. */
export function contextGraphIds(graphs: unknown): string[] {
  return Array.isArray(graphs) ? graphs.map((g) => (g as { id?: unknown })?.id).filter((x): x is string => typeof x === 'string') : [];
}

/** React hook: the identity colour of a context graph, as a CSS value. */
export function useContextGraphColor(id: string | null | undefined): string {
  const graphs = useProjectsStore((s) => s.contextGraphs);
  if (!id) return 'var(--text-tertiary)';
  return contextGraphColor(id, contextGraphIds(graphs));
}

/** For a center tab id like `project:<cgId>`; null for non-graph tabs. */
export function contextGraphIdFromTab(tabId: string): string | null {
  const t = decodeTabId(tabId);
  return t.kind === 'graph' ? t.contextGraphId : null;
}

/** First letter (or digit) of a graph's display name, for the monogram tile. */
export function contextGraphInitial(name: string | null | undefined, id?: string): string {
  const src = (name || id || '?').replace(/^cg:/i, '').trim();
  const m = src.match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : '?').toUpperCase();
}

/**
 * Context graph identity mark: a rounded square with the graph's initial,
 * in its identity colour. Squares mean "context graph"; data marks (nodes,
 * chart marks, legend swatches) are always round, so the two never read as
 * each other even when they share a hue.
 */
export function ContextGraphMark({ id, name, size = 'sm' }: { id: string; name?: string | null; size?: 'sm' | 'md' }) {
  const color = useContextGraphColor(id);
  return createElement('span', {
    className: `v10-cg-mark v10-cg-mark-${size}`,
    style: { '--cg-color': color } as Record<string, string>,
    // Drawn via CSS ::before so the letter stays out of textContent
    // (labels, copy/paste and text queries see only the graph's name).
    'data-initial': contextGraphInitial(name, id),
    'aria-hidden': true,
  });
}
