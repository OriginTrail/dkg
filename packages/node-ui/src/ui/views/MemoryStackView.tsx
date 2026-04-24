/**
 * Memory Stack — cross-project "10,000-ft view" of every layer across
 * every project the user is in.
 *
 * Each visible, non-hidden project becomes a row with three cards:
 * Working / Shared / Verified Memory. Each card shows the layer's
 * entity + triple counts for that project, a short preview of the
 * newest entities, and a button that deep-links into the project's
 * layer tab (reusing the existing `wm:` / `swm:` / `vm:` tab ids).
 *
 * Data strategy: one `useMemoryEntities` per project. That's fine for
 * PoC scales (handful of projects, 10-50k triples each); we can swap
 * in a dedicated lightweight "layer counts" endpoint later if the tree
 * grows past ~10 projects.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useProjectsStore, type ContextGraph } from '../stores/projects.js';
import { useTabsStore } from '../stores/tabs.js';
import { useMemoryEntities, type MemoryEntity, type TrustLevel } from '../hooks/useMemoryEntities.js';
import { relativeTime } from '../hooks/useProjectActivity.js';

const HIDDEN_KEY = 'v10:hiddenProjectIds';
const HIDDEN_CHANGE_EVENT = 'v10:hidden-projects-change';

const LAYERS: Array<{
  key: 'working' | 'shared' | 'verified';
  title: string;
  short: string;
  icon: string;
  color: string;
  desc: string;
  tabPrefix: 'wm' | 'swm' | 'vm';
}> = [
  { key: 'working',  title: 'Working Memory',        short: 'WM',  icon: '◇', color: '#64748b', desc: 'Private agent drafts', tabPrefix: 'wm' },
  { key: 'shared',   title: 'Shared Working Memory', short: 'SWM', icon: '◈', color: '#f59e0b', desc: 'Team proposals',       tabPrefix: 'swm' },
  { key: 'verified', title: 'Verified Memory',       short: 'VM',  icon: '◉', color: '#22c55e', desc: 'On-chain knowledge',   tabPrefix: 'vm' },
];

const TS_PREDS = [
  'http://purl.org/dc/terms/created',
  'http://dkg.io/ontology/github/mergedAt',
  'http://dkg.io/ontology/github/closedAt',
  'http://dkg.io/ontology/decisions/date',
  'http://dkg.io/ontology/tasks/dueDate',
];

// Mirror of PanelLeft's hidden-projects preference so the Memory Stack
// never surfaces projects the user has dismissed from the sidebar.
function useHiddenIds(): Set<string> {
  const read = () => {
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set<string>(Array.isArray(arr) ? arr : []);
    } catch { return new Set<string>(); }
  };
  const [hidden, setHidden] = useState<Set<string>>(read);
  useEffect(() => {
    const sync = () => setHidden(read());
    window.addEventListener(HIDDEN_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDDEN_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return hidden;
}

export function MemoryStackView() {
  const { contextGraphs } = useProjectsStore();
  const hidden = useHiddenIds();
  const visible = useMemo(
    () => contextGraphs.filter(cg => !hidden.has(cg.id)),
    [contextGraphs, hidden],
  );

  return (
    <div className="v10-memstack">
      <div className="v10-memstack-head">
        <h1 className="v10-memstack-title">Memory Stack</h1>
        <p className="v10-memstack-sub">
          Every layer across every project, at a glance. {visible.length} visible project{visible.length === 1 ? '' : 's'} ·
          hidden projects are skipped.
        </p>
      </div>

      {visible.length === 0 ? (
        <div className="v10-memstack-empty">
          No visible projects. Create one from the sidebar or un-hide dismissed ones.
        </div>
      ) : (
        <div className="v10-memstack-table">
          <div className="v10-memstack-colheads">
            <div className="v10-memstack-colhead project" />
            {LAYERS.map(L => (
              <div key={L.key} className="v10-memstack-colhead" style={{ color: L.color }}>
                <span className="v10-memstack-colhead-icon">{L.icon}</span>
                <span className="v10-memstack-colhead-title">{L.title}</span>
                <span className="v10-memstack-colhead-desc">{L.desc}</span>
              </div>
            ))}
          </div>
          {visible.map(cg => (
            <MemoryStackRow key={cg.id} cg={cg} />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryStackRow({ cg }: { cg: ContextGraph }) {
  const memory = useMemoryEntities(cg.id);
  const { openTab } = useTabsStore();

  // Bucket entities + triple-counts per layer in one pass.
  const byLayer = useMemo(() => {
    const buckets: Record<TrustLevel, { entities: MemoryEntity[]; tripleCount: number }> = {
      working:  { entities: [], tripleCount: 0 },
      shared:   { entities: [], tripleCount: 0 },
      verified: { entities: [], tripleCount: 0 },
    };
    for (const e of memory.entityList) {
      buckets[e.trustLevel].entities.push(e);
    }
    for (const t of memory.allTriples) {
      buckets[t.layer].tripleCount++;
    }
    // Sort each bucket newest-first using whichever timestamp predicate
    // each entity has; undated items slide to the back.
    for (const k of Object.keys(buckets) as TrustLevel[]) {
      buckets[k].entities.sort((a, b) => {
        const ta = firstTs(a); const tb = firstTs(b);
        if (ta && tb) return tb - ta;
        if (ta) return -1;
        if (tb) return 1;
        return a.label.localeCompare(b.label);
      });
    }
    return buckets;
  }, [memory.entityList, memory.allTriples]);

  const openProject = () =>
    openTab({
      id: `project:${cg.id}`,
      label: cg.name || cg.id.slice(0, 16),
      closable: true,
    });

  return (
    <div className="v10-memstack-row">
      <div className="v10-memstack-project">
        <button type="button" className="v10-memstack-project-btn" onClick={openProject}>
          <span className="v10-memstack-project-dot" />
          <span className="v10-memstack-project-name">{cg.name || cg.id}</span>
        </button>
        {cg.description && (
          <div className="v10-memstack-project-desc" title={cg.description}>
            {cg.description}
          </div>
        )}
        {memory.loading && !memory.entityList.length && (
          <div className="v10-memstack-project-status">loading…</div>
        )}
        {memory.error && (
          <div className="v10-memstack-project-status error">{memory.error}</div>
        )}
      </div>
      {LAYERS.map(L => {
        const bucket = byLayer[L.key];
        return (
          <LayerCell
            key={L.key}
            cgId={cg.id}
            color={L.color}
            layerTitle={L.title}
            tabPrefix={L.tabPrefix}
            entityCount={bucket.entities.length}
            tripleCount={bucket.tripleCount}
            recent={bucket.entities.slice(0, 4)}
            onOpenLayer={() =>
              openTab({
                id: `${L.tabPrefix}:${cg.id}`,
                label: `${L.short} · ${cg.name || cg.id.slice(0, 12)}`,
                closable: true,
              })
            }
          />
        );
      })}
    </div>
  );
}

function LayerCell({
  cgId: _cgId,
  color,
  layerTitle,
  tabPrefix,
  entityCount,
  tripleCount,
  recent,
  onOpenLayer,
}: {
  cgId: string;
  color: string;
  layerTitle: string;
  tabPrefix: 'wm' | 'swm' | 'vm';
  entityCount: number;
  tripleCount: number;
  recent: MemoryEntity[];
  onOpenLayer: () => void;
}) {
  const isEmpty = entityCount === 0;
  return (
    <div
      className={`v10-memstack-cell${isEmpty ? ' empty' : ''}`}
      style={{ '--cell-color': color } as React.CSSProperties}
    >
      <div className="v10-memstack-cell-stats">
        <span className="v10-memstack-cell-n">{entityCount}</span>
        <span className="v10-memstack-cell-n-lbl">
          entit{entityCount === 1 ? 'y' : 'ies'}
        </span>
        <span className="v10-memstack-cell-sep">·</span>
        <span className="v10-memstack-cell-t">{tripleCount.toLocaleString()}</span>
        <span className="v10-memstack-cell-t-lbl">triples</span>
      </div>
      {recent.length > 0 ? (
        <ul className="v10-memstack-cell-recent">
          {recent.map(e => (
            <li key={e.uri} className="v10-memstack-cell-recent-item" title={e.label}>
              <span className="v10-memstack-cell-recent-bullet" />
              <span className="v10-memstack-cell-recent-label">{e.label}</span>
              <span className="v10-memstack-cell-recent-time">{relativeTime(firstDate(e))}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="v10-memstack-cell-empty-hint">Nothing in {tabPrefix.toUpperCase()} yet</div>
      )}
      {!isEmpty && (
        <button
          type="button"
          className="v10-memstack-cell-open"
          onClick={onOpenLayer}
          title={`Open ${layerTitle}`}
        >
          Open {tabPrefix.toUpperCase()} →
        </button>
      )}
    </div>
  );
}

// Grab the first usable timestamp value for ordering / display.
function firstTs(e: MemoryEntity): number | null {
  for (const p of TS_PREDS) {
    const v = e.properties.get(p)?.[0];
    if (!v) continue;
    const d = new Date(v.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1'));
    if (Number.isFinite(d.getTime())) return d.getTime();
  }
  return null;
}
function firstDate(e: MemoryEntity): Date | null {
  const ts = firstTs(e);
  return ts ? new Date(ts) : null;
}
