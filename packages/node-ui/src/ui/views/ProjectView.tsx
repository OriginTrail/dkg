import React, { useMemo, useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { ImportFilesModal } from '../components/Modals/ImportFilesModal.js';
import { useMemoryEntities, type TrustLevel, type MemoryEntity, type Triple } from '../hooks/useMemoryEntities.js';
import { TrustSummaryBar, TrustBadge } from '../components/MemoryExplorer/TrustIndicator.js';

const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);

interface ProjectViewProps {
  contextGraphId: string;
}

type ViewTab = 'timeline' | 'graph' | 'knowledge';

const TRUST_COLORS: Record<TrustLevel, string> = {
  verified: '#22c55e',
  shared: '#f59e0b',
  working: '#64748b',
};

const TRUST_LABELS: Record<TrustLevel, string> = {
  verified: 'Verified',
  shared: 'Shared',
  working: 'Private',
};

const TYPE_LABELS: Record<string, { icon: string; group: string }> = {
  Person: { icon: '👤', group: 'People' },
  SoftwareApplication: { icon: '💻', group: 'Software' },
  SoftwareSourceCode: { icon: '📦', group: 'Code' },
  Organization: { icon: '🏢', group: 'Organizations' },
  Event: { icon: '📅', group: 'Events' },
  ChooseAction: { icon: '⚡', group: 'Decisions' },
  DefinedTerm: { icon: '📘', group: 'Concepts' },
  CreativeWork: { icon: '📄', group: 'Documents' },
  Product: { icon: '🪙', group: 'Products' },
  ConversationTurn: { icon: '💬', group: 'Conversations' },
  Thing: { icon: '◆', group: 'Other' },
};

function shortType(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

function shortPred(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  const raw = cut >= 0 ? uri.slice(cut + 1) : uri;
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

function entityMeta(e: MemoryEntity) {
  const primaryType = e.types[0] ? shortType(e.types[0]) : 'Entity';
  const info = TYPE_LABELS[primaryType] ?? TYPE_LABELS.Thing;
  return { ...info, type: primaryType };
}

function isConversationTurn(e: MemoryEntity): boolean {
  return e.types.some(t => t.includes('ConversationTurn'));
}

function getDate(e: MemoryEntity): string | null {
  const datePreds = ['http://schema.org/startDate', 'http://schema.org/dateCreated', 'http://schema.org/datePublished'];
  for (const p of datePreds) {
    const v = e.properties.get(p);
    if (v?.[0]) return v[0];
  }
  return null;
}

function getDescription(e: MemoryEntity): string | null {
  const descPreds = ['http://schema.org/description', 'http://schema.org/text'];
  for (const p of descPreds) {
    const v = e.properties.get(p);
    if (v?.[0]) return v[0];
  }
  return null;
}

function getAgentTool(e: MemoryEntity): string | null {
  const v = e.properties.get('http://schema.org/additionalType');
  return v?.[0] ?? null;
}

function humanizeLabel(entity: MemoryEntity | undefined, uri: string): string {
  if (entity) return entity.label;
  const slash = uri.lastIndexOf('/');
  const hash = uri.lastIndexOf('#');
  const cut = Math.max(slash, hash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

const CONTRIBUTOR_PREDS = new Set([
  'http://schema.org/contributor',
  'http://schema.org/author',
  'http://schema.org/agent',
  'http://schema.org/creator',
]);

function neighborhoodTriples(entityUri: string, allTriples: Triple[], hops: number = 2): Triple[] {
  const visited = new Set<string>([entityUri]);
  let frontier = new Set<string>([entityUri]);

  for (let i = 0; i < hops; i++) {
    const nextFrontier = new Set<string>();
    for (const t of allTriples) {
      if (frontier.has(t.subject) && !visited.has(t.object)) {
        nextFrontier.add(t.object);
      }
      if (frontier.has(t.object) && !visited.has(t.subject)) {
        nextFrontier.add(t.subject);
      }
    }
    for (const u of nextFrontier) visited.add(u);
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  return allTriples.filter(t => visited.has(t.subject) || visited.has(t.object));
}

// ─── Trust Status Box ────────────────────────────────────────

function TrustStatusBox({ level }: { level: TrustLevel }) {
  const color = TRUST_COLORS[level];
  const label = TRUST_LABELS[level];
  return (
    <span className="v10-trust-status-box" style={{ borderColor: color, color }}>
      {label}
    </span>
  );
}

// ─── Project Home Header ─────────────────────────────────────

function ProjectHome({ cg, memory }: {
  cg: any;
  memory: ReturnType<typeof useMemoryEntities>;
}) {
  const agents = useMemo(() => {
    const found: Array<{ uri: string; label: string; tool: string | null }> = [];
    const seen = new Set<string>();
    for (const [, e] of memory.entities) {
      const isPerson = e.types.some(t => t.includes('Person'));
      const isAgent = e.types.some(t => t.includes('SoftwareApplication'));
      if (!isPerson && !isAgent) continue;
      const tool = getAgentTool(e);
      if ((tool || isPerson) && !seen.has(e.uri)) {
        seen.add(e.uri);
        found.push({ uri: e.uri, label: e.label, tool });
      }
    }
    return found;
  }, [memory.entities]);

  const turnCount = useMemo(() => {
    let c = 0;
    for (const e of memory.entityList) {
      if (isConversationTurn(e)) c++;
    }
    return c;
  }, [memory.entityList]);

  return (
    <div className="v10-ph">
      {cg.description && <p className="v10-ph-desc">{cg.description}</p>}
      <div className="v10-ph-stats">
        <div className="v10-ph-stat">
          <span className="v10-ph-stat-val">{memory.counts.total}</span>
          <span className="v10-ph-stat-label">entities</span>
        </div>
        <div className="v10-ph-stat">
          <span className="v10-ph-stat-val">{memory.graphTriples.length}</span>
          <span className="v10-ph-stat-label">facts</span>
        </div>
        <div className="v10-ph-stat">
          <span className="v10-ph-stat-val">{turnCount}</span>
          <span className="v10-ph-stat-label">turns</span>
        </div>
        <div className="v10-ph-stat">
          <span className="v10-ph-stat-val">{agents.length}</span>
          <span className="v10-ph-stat-label">participants</span>
        </div>
      </div>
      {agents.length > 0 && (
        <div className="v10-ph-agents">
          <span className="v10-ph-agents-label">Participants</span>
          <div className="v10-ph-agents-list">
            {agents.map(a => (
              <span key={a.uri} className="v10-ph-agent-chip">
                {a.label}
                {a.tool && <span className="v10-ph-agent-tool">{a.tool}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Timeline (only dated items — conversation turns + dated entities) ─────

function TimelineView({ memory, search, onSelect }: {
  memory: ReturnType<typeof useMemoryEntities>;
  search: string;
  onSelect: (uri: string) => void;
}) {
  const items = useMemo(() => {
    const dated: Array<{ date: string; time: string | null; entity: MemoryEntity; isConvTurn: boolean }> = [];

    for (const e of memory.entityList) {
      if (search && !matchesSearch(e, search)) continue;
      const d = getDate(e);
      if (!d) continue;
      const isTurn = isConversationTurn(e);
      const dateStr = d.split('T')[0] ?? d;
      const timeStr = d.includes('T') ? d.split('T')[1]?.slice(0, 5) ?? null : null;
      dated.push({ date: dateStr, time: timeStr, entity: e, isConvTurn: isTurn });
    }

    dated.sort((a, b) => {
      const cmp = b.date.localeCompare(a.date);
      if (cmp !== 0) return cmp;
      return (b.time ?? '').localeCompare(a.time ?? '');
    });

    const dateGroups = new Map<string, typeof dated>();
    for (const item of dated) {
      const list = dateGroups.get(item.date) ?? [];
      list.push(item);
      dateGroups.set(item.date, list);
    }

    return [...dateGroups.entries()];
  }, [memory.entityList, search]);

  if (items.length === 0) {
    return <div className="v10-tl-empty">No dated entries found.</div>;
  }

  return (
    <div className="v10-tl-scroll">
      {items.map(([date, entries]) => (
        <div key={date} className="v10-tl-date-group">
          <div className="v10-tl-date-label">{date}</div>
          <div className="v10-tl-date-items">
            {entries.map(({ entity, isConvTurn, time }) =>
              isConvTurn
                ? <ConversationTurnCard key={entity.uri} entity={entity} allEntities={memory.entities} onSelect={onSelect} time={time} />
                : <NarrativeCard key={entity.uri} entity={entity} allEntities={memory.entities} onSelect={onSelect} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Conversation Turn Card ──────────────────────────────────

function ConversationTurnCard({ entity, allEntities, onSelect, time }: {
  entity: MemoryEntity;
  allEntities: Map<string, MemoryEntity>;
  onSelect: (uri: string) => void;
  time: string | null;
}) {
  const speaker = entity.connections.find(c =>
    c.predicate === 'http://schema.org/agent' || c.predicate === 'http://schema.org/author'
  );
  const speakerEntity = speaker ? allEntities.get(speaker.targetUri) : undefined;
  const speakerName = humanizeLabel(speakerEntity, speaker?.targetUri ?? '');
  const speakerTool = entity.properties.get('http://dkg.io/ontology/speakerTool')?.[0]
    ?? (speakerEntity ? getAgentTool(speakerEntity) : null);

  const desc = getDescription(entity);

  const mentions = useMemo(() => {
    const result: Array<{ uri: string; label: string }> = [];
    for (const conn of entity.connections) {
      if (conn.predicate === 'http://schema.org/mentions') {
        result.push({ uri: conn.targetUri, label: conn.targetLabel });
      }
    }
    return result;
  }, [entity.connections]);

  const trustColor = TRUST_COLORS[entity.trustLevel];

  return (
    <div className="v10-conv-turn" style={{ borderLeftColor: trustColor }} onClick={() => onSelect(entity.uri)} role="button" tabIndex={0}>
      <div className="v10-conv-turn-main">
        <div className="v10-conv-turn-header">
          <span className="v10-conv-speaker">{speakerName}</span>
          {speakerTool && <span className="v10-conv-tool">{speakerTool}</span>}
          {time && <span className="v10-conv-time">{time}</span>}
        </div>

        <div className="v10-conv-title">{entity.label}</div>

        {desc && (
          <div className="v10-conv-body">
            {desc.length > 400 ? desc.slice(0, 400) + '...' : desc}
          </div>
        )}

        {mentions.length > 0 && (
          <div className="v10-conv-mentions">
            {mentions.map(m => (
              <span
                key={m.uri}
                className="v10-conv-mention"
                onClick={(e) => { e.stopPropagation(); onSelect(m.uri); }}
                role="link"
                tabIndex={0}
              >
                {m.label}
              </span>
            ))}
          </div>
        )}

        <div className="v10-conv-turn-footer">
          <span className="v10-conv-turn-uri">{entity.uri.split('/').pop()}</span>
        </div>
      </div>

      <TrustStatusBox level={entity.trustLevel} />
    </div>
  );
}

// ─── Narrative Card (non-turn entities) ──────────────────────

function NarrativeCard({ entity, allEntities, onSelect }: {
  entity: MemoryEntity;
  allEntities: Map<string, MemoryEntity>;
  onSelect: (uri: string) => void;
}) {
  const { icon, type } = entityMeta(entity);
  const desc = getDescription(entity);
  const trustColor = TRUST_COLORS[entity.trustLevel];

  const { contributors, otherOut, incoming } = useMemo(() => {
    const contribs: Array<{ uri: string; label: string; agentTool: string | null }> = [];
    const other = new Map<string, Array<{ uri: string; label: string }>>();

    for (const conn of entity.connections) {
      if (CONTRIBUTOR_PREDS.has(conn.predicate)) {
        const target = allEntities.get(conn.targetUri);
        contribs.push({
          uri: conn.targetUri,
          label: conn.targetLabel,
          agentTool: target ? getAgentTool(target) : null,
        });
      } else {
        const pred = shortPred(conn.predicate);
        const list = other.get(pred) ?? [];
        list.push({ uri: conn.targetUri, label: conn.targetLabel });
        other.set(pred, list);
      }
    }

    const inc: Array<{ pred: string; uri: string; label: string; agentTool: string | null }> = [];
    for (const [, o] of allEntities) {
      for (const conn of o.connections) {
        if (conn.targetUri === entity.uri) {
          if (CONTRIBUTOR_PREDS.has(conn.predicate)) {
            contribs.push({ uri: o.uri, label: o.label, agentTool: getAgentTool(o) });
          } else {
            inc.push({ pred: shortPred(conn.predicate), uri: o.uri, label: o.label, agentTool: null });
          }
        }
      }
    }

    const seen = new Set<string>();
    const deduped = contribs.filter(c => { if (seen.has(c.uri)) return false; seen.add(c.uri); return true; });

    return { contributors: deduped, otherOut: [...other.entries()], incoming: inc };
  }, [entity, allEntities]);

  const clickEntity = (e: React.MouseEvent, uri: string) => {
    e.stopPropagation();
    onSelect(uri);
  };

  return (
    <div className="v10-nc" style={{ borderLeftColor: trustColor }} onClick={() => onSelect(entity.uri)} role="button" tabIndex={0}>
      <div className="v10-nc-main">
        <div className="v10-nc-header">
          <span className="v10-nc-icon">{icon}</span>
          <span className="v10-nc-label">{entity.label}</span>
        </div>

        {contributors.length > 0 && (
          <div className="v10-nc-contributors">
            {contributors.map((c, i) => (
              <span key={c.uri} className="v10-nc-contributor" onClick={(e) => clickEntity(e, c.uri)} role="link" tabIndex={0}>
                {i > 0 && <span className="v10-nc-contrib-sep">·</span>}
                <span className="v10-nc-contrib-name">{c.label}</span>
                {c.agentTool && <span className="v10-nc-contrib-tool">{c.agentTool}</span>}
              </span>
            ))}
          </div>
        )}

        {desc && <p className="v10-nc-desc">{desc}</p>}

        {(otherOut.length > 0 || incoming.length > 0) && (
          <div className="v10-nc-rels">
            {otherOut.map(([pred, targets]) => (
              <span key={pred} className="v10-nc-rel">
                <span className="v10-nc-rel-pred">{pred}</span>
                {targets.map((t, i) => (
                  <span key={t.uri} className="v10-nc-rel-target v10-nc-rel-clickable" onClick={(e) => clickEntity(e, t.uri)} role="link" tabIndex={0}>
                    {i > 0 && ', '}{t.label}
                  </span>
                ))}
              </span>
            ))}
            {incoming.map((inc, i) => (
              <span key={`in-${i}`} className="v10-nc-rel">
                <span className="v10-nc-rel-pred">← {inc.pred}</span>
                <span className="v10-nc-rel-target v10-nc-rel-clickable" onClick={(e) => clickEntity(e, inc.uri)} role="link" tabIndex={0}>
                  {inc.label}
                </span>
              </span>
            ))}
          </div>
        )}

        <div className="v10-nc-footer">
          <span className="v10-nc-type">{type}</span>
          <span className="v10-nc-stats">
            {entity.connections.length} links · {entity.properties.size} props
          </span>
        </div>
      </div>

      <TrustStatusBox level={entity.trustLevel} />
    </div>
  );
}

// ─── Knowledge Assets View (all non-turn entities, rich cards) ─────

function KnowledgeAssetsView({ memory, search, onSelect }: {
  memory: ReturnType<typeof useMemoryEntities>;
  search: string;
  onSelect: (uri: string) => void;
}) {
  const typeGroups = useMemo(() => {
    const groups = new Map<string, MemoryEntity[]>();
    for (const e of memory.entityList) {
      if (isConversationTurn(e)) continue;
      if (search && !matchesSearch(e, search)) continue;
      const { group } = entityMeta(e);
      const list = groups.get(group) ?? [];
      list.push(e);
      groups.set(group, list);
    }
    const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [, entities] of entries) {
      entities.sort((a, b) => {
        const connDiff = b.connections.length - a.connections.length;
        if (connDiff !== 0) return connDiff;
        return a.label.localeCompare(b.label);
      });
    }
    return entries;
  }, [memory.entityList, search]);

  if (typeGroups.length === 0) {
    return <div className="v10-tl-empty">No knowledge assets found.</div>;
  }

  return (
    <div className="v10-tl-scroll">
      {typeGroups.map(([group, entities]) => (
        <div key={group} className="v10-tl-type-group">
          <div className="v10-tl-type-label">{group} ({entities.length})</div>
          <div className="v10-tl-date-items">
            {entities.map(e => (
              <NarrativeCard key={e.uri} entity={e} allEntities={memory.entities} onSelect={onSelect} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Graph View (full graph, preserved from before) ──────────

function GraphView({ memory, nodeColors, onNodeClick }: {
  memory: ReturnType<typeof useMemoryEntities>;
  nodeColors: Record<string, string>;
  onNodeClick: (node: any) => void;
}) {
  const graphOptions = useMemo(() => ({
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: {
      predicates: [
        'http://schema.org/name',
        'http://www.w3.org/2000/01/rdf-schema#label',
        'http://purl.org/dc/terms/title',
        'http://schema.org/text',
      ],
      minZoomForLabels: 0.3,
    },
    style: {
      nodeColors,
      defaultNodeColor: TRUST_COLORS.working,
      defaultEdgeColor: '#334155',
      edgeWidth: 0.7,
      fontSize: 16,
    },
    hexagon: { baseSize: 7, minSize: 5, maxSize: 10, scaleWithDegree: true },
    focus: { maxNodes: 3000, hops: 999 },
  }), [nodeColors]);

  return (
    <div className="v10-gv-container">
      <Suspense fallback={<div className="v10-me-graph-loading">Loading graph...</div>}>
        <RdfGraph
          data={memory.graphTriples}
          format="triples"
          options={graphOptions}
          style={{ width: '100%', height: '100%' }}
          onNodeClick={onNodeClick}
          initialFit
        />
      </Suspense>
      <div className="v10-me-graph-legend">
        <span className="v10-me-legend-item">
          <span className="v10-me-legend-dot" style={{ background: TRUST_COLORS.verified }} /> Verified
        </span>
        <span className="v10-me-legend-item">
          <span className="v10-me-legend-dot" style={{ background: TRUST_COLORS.shared }} /> Shared
        </span>
        <span className="v10-me-legend-item">
          <span className="v10-me-legend-dot" style={{ background: TRUST_COLORS.working }} /> Draft
        </span>
      </div>
    </div>
  );
}

// ─── Drill-down panel (2-hop focused graph + rich card) ──────

function DrilldownPanel({ entity, allEntities, allTriples, nodeColors, onNavigate, onClose, contextGraphId }: {
  entity: MemoryEntity;
  allEntities: Map<string, MemoryEntity>;
  allTriples: Triple[];
  nodeColors: Record<string, string>;
  onNavigate: (uri: string) => void;
  onClose: () => void;
  contextGraphId: string;
}) {
  const { icon, type } = entityMeta(entity);
  const desc = getDescription(entity);

  const hoodTriples = useMemo(
    () => neighborhoodTriples(entity.uri, allTriples, 2),
    [entity.uri, allTriples]
  );

  const hoodOptions = useMemo(() => ({
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: {
      predicates: ['http://schema.org/name', 'http://www.w3.org/2000/01/rdf-schema#label'],
      minZoomForLabels: 0.2,
    },
    style: {
      nodeColors,
      defaultNodeColor: TRUST_COLORS.working,
      defaultEdgeColor: '#475569',
      edgeWidth: 1.0,
      fontSize: 16,
    },
    hexagon: { baseSize: 7, minSize: 4, maxSize: 10, scaleWithDegree: true },
    focus: { maxNodes: 500, hops: 999 },
    autoFitDisabled: true,
  }), [nodeColors]);

  const incoming = useMemo(() => {
    const result: Array<{ pred: string; entity: MemoryEntity }> = [];
    for (const [, other] of allEntities) {
      for (const conn of other.connections) {
        if (conn.targetUri === entity.uri) {
          result.push({ pred: shortPred(conn.predicate), entity: other });
        }
      }
    }
    return result;
  }, [entity.uri, allEntities]);

  const mentionedIn = useMemo(() => {
    const turns: Array<{ entity: MemoryEntity; date: string | null }> = [];
    for (const [, other] of allEntities) {
      if (!isConversationTurn(other)) continue;
      const mentions = other.connections.some(c =>
        c.targetUri === entity.uri && c.predicate === 'http://schema.org/mentions'
      );
      if (mentions) {
        turns.push({ entity: other, date: getDate(other) });
      }
    }
    turns.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return turns;
  }, [entity.uri, allEntities]);

  const sourceFile = useMemo(() => {
    const conn = entity.connections.find(c => c.predicate === 'http://dkg.io/ontology/sourceFile');
    return conn?.targetUri ?? null;
  }, [entity]);

  const [similar, setSimilar] = useState<Array<{ entityUri: string; label: string | null; similarity: number }>>([]);
  useEffect(() => {
    const label = entity.label;
    if (!label || !contextGraphId) return;
    let cancelled = false;
    const token = typeof window !== 'undefined' ? (window as any).__DKG_TOKEN__ : null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch('/api/memory/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: label, contextGraphId, limit: 5, memoryLayers: ['swm', 'vm'] }),
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled || !data.results) return;
        setSimilar(
          data.results
            .filter((r: any) => r.entityUri !== entity.uri)
            .slice(0, 5)
            .map((r: any) => ({ entityUri: r.entityUri, label: r.label, similarity: r.similarity }))
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [entity.uri, entity.label, contextGraphId]);

  return (
    <div className="v10-dd-panel">
      <div className="v10-dd-header">
        <button className="v10-dd-back" onClick={onClose}>← Back</button>
      </div>

      <div className="v10-dd-graph">
        <Suspense fallback={<div className="v10-me-graph-loading">Loading...</div>}>
          <RdfGraph
            data={hoodTriples}
            format="triples"
            options={hoodOptions}
            style={{ width: '100%', height: '100%' }}
            onNodeClick={(n: any) => n?.id && n.id !== entity.uri && onNavigate(n.id)}
            initialFit
          />
        </Suspense>
        <div className="v10-dd-graph-info">
          {hoodTriples.length} facts in neighborhood
        </div>
      </div>

      <div className="v10-dd-card">
        <div className="v10-dd-card-header">
          <span className="v10-dd-icon">{icon}</span>
          <div>
            <h2 className="v10-dd-title">{entity.label}</h2>
            <div className="v10-dd-type-row">
              <span className="v10-dd-type">{type}</span>
              <TrustStatusBox level={entity.trustLevel} />
            </div>
          </div>
        </div>

        {desc && <p className="v10-dd-desc">{desc}</p>}

        <div className="v10-dd-uri mono">{entity.uri}</div>

        {sourceFile && (
          <div className="v10-dd-section">
            <h4 className="v10-dd-section-title">Source</h4>
            <a className="v10-dd-source-link" href={`/api/file/${encodeURIComponent(sourceFile.replace('urn:dkg:file:', ''))}`} target="_blank" rel="noreferrer">
              View source file
            </a>
          </div>
        )}

        {entity.properties.size > 0 && (
          <div className="v10-dd-section">
            <h4 className="v10-dd-section-title">Properties</h4>
            {[...entity.properties].map(([pred, vals]) => (
              <div key={pred} className="v10-dd-prop">
                <span className="v10-dd-prop-key">{shortPred(pred)}</span>
                <span className="v10-dd-prop-val">{vals.join(', ')}</span>
              </div>
            ))}
          </div>
        )}

        {entity.connections.length > 0 && (
          <div className="v10-dd-section">
            <h4 className="v10-dd-section-title">Links to ({entity.connections.length})</h4>
            {entity.connections.map((conn, i) => (
              <button key={i} className="v10-dd-conn" onClick={() => onNavigate(conn.targetUri)}>
                <span className="v10-dd-conn-pred">{shortPred(conn.predicate)}</span>
                <span className="v10-dd-conn-arrow">→</span>
                <span className="v10-dd-conn-target">{conn.targetLabel}</span>
              </button>
            ))}
          </div>
        )}

        {incoming.length > 0 && (
          <div className="v10-dd-section">
            <h4 className="v10-dd-section-title">Referenced by ({incoming.length})</h4>
            {incoming.map((inc, i) => (
              <button key={i} className="v10-dd-conn" onClick={() => onNavigate(inc.entity.uri)}>
                <span className="v10-dd-conn-target">{inc.entity.label}</span>
                <span className="v10-dd-conn-arrow">→</span>
                <span className="v10-dd-conn-pred">{inc.pred}</span>
              </button>
            ))}
          </div>
        )}

        {mentionedIn.length > 0 && (
          <div className="v10-dd-section">
            <h4 className="v10-dd-section-title">Mentioned in ({mentionedIn.length} turns)</h4>
            {mentionedIn.map((m, i) => (
              <button key={i} className="v10-dd-conn" onClick={() => onNavigate(m.entity.uri)}>
                <span className="v10-dd-conn-target">{m.entity.label}</span>
                {m.date && <span className="v10-dd-conn-date">{m.date}</span>}
              </button>
            ))}
          </div>
        )}

        {similar.length > 0 && (
          <div className="v10-dd-section">
            <h4 className="v10-dd-section-title">Similar</h4>
            {similar.map((s, i) => {
              const target = allEntities.get(s.entityUri);
              return (
                <button key={i} className="v10-dd-conn" onClick={() => onNavigate(s.entityUri)}>
                  <span className="v10-dd-conn-target">{target?.label ?? s.label ?? s.entityUri}</span>
                  {s.similarity != null && (
                    <span className="v10-dd-conn-sim">{Math.round(s.similarity * 100)}%</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Search helper ───────────────────────────────────────────

function matchesSearch(e: MemoryEntity, q: string): boolean {
  const lower = q.toLowerCase();
  if (e.label.toLowerCase().includes(lower)) return true;
  if (e.uri.toLowerCase().includes(lower)) return true;
  for (const t of e.types) if (shortType(t).toLowerCase().includes(lower)) return true;
  for (const [, vals] of e.properties) {
    for (const v of vals) if (v.toLowerCase().includes(lower)) return true;
  }
  for (const c of e.connections) if (c.targetLabel.toLowerCase().includes(lower)) return true;
  return false;
}

// ─── Main ProjectView ────────────────────────────────────────

export function ProjectView({ contextGraphId }: ProjectViewProps) {
  const { data: cgData } = useFetch(api.fetchContextGraphs, [], 30_000);
  const [showImport, setShowImport] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>('timeline');
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const cg = useMemo(
    () => cgData?.contextGraphs?.find((c: any) => c.id === contextGraphId),
    [cgData, contextGraphId]
  );

  const memory = useMemoryEntities(contextGraphId);

  const selectedEntity = useMemo(
    () => selectedUri ? memory.entities.get(selectedUri) ?? null : null,
    [selectedUri, memory.entities]
  );

  const nodeColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const [uri, entity] of memory.entities) {
      colors[uri] = TRUST_COLORS[entity.trustLevel];
    }
    return colors;
  }, [memory.entities]);

  const handleSelect = useCallback((uri: string) => {
    setSelectedUri(uri);
  }, []);

  const handleNavigate = useCallback((uri: string) => {
    setSelectedUri(uri);
  }, []);

  const handleNodeClick = useCallback((node: any) => {
    if (node?.id) setSelectedUri(node.id);
  }, []);

  if (!cg) {
    return (
      <div className="v10-view-placeholder">
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading context graph...</p>
      </div>
    );
  }

  const hasData = memory.entityList.length > 0;

  return (
    <div className="v10-memory-explorer">
      {/* ── Header ── */}
      <div className="v10-me-header">
        <div className="v10-me-header-left">
          <div className="v10-me-project-dot" />
          <div>
            <h1 className="v10-me-title">{cg.name || cg.id}</h1>
          </div>
        </div>
        <div className="v10-me-header-actions">
          <button className="v10-me-action-btn" onClick={() => setShowImport(true)}>↑ Import</button>
          <button className="v10-me-action-btn" onClick={memory.refresh}>↻</button>
        </div>
      </div>

      {hasData && <ProjectHome cg={cg} memory={memory} />}

      <TrustSummaryBar counts={memory.counts} />

      {/* ── Search + Tab bar ── */}
      {hasData && (
        <div className="v10-me-toolbar">
          <div className="v10-me-tabs">
            {(['timeline', 'graph', 'knowledge'] as ViewTab[]).map(tab => (
              <button
                key={tab}
                className={`v10-me-tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => { setActiveTab(tab); setSelectedUri(null); }}
              >
                {tab === 'timeline' ? '◷ Timeline' : tab === 'graph' ? '⬡ Graph' : '◈ Knowledge Assets'}
              </button>
            ))}
          </div>
          <input
            className="v10-me-search"
            type="text"
            placeholder="Search memory..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      )}

      {memory.loading && (
        <div className="v10-me-loading"><div className="v10-me-loading-text">Loading memory...</div></div>
      )}
      {memory.error && (
        <div className="v10-me-error">Error: {memory.error}</div>
      )}

      {/* ── Drilldown overlay ── */}
      {!memory.loading && hasData && selectedEntity && (
        <DrilldownPanel
          entity={selectedEntity}
          allEntities={memory.entities}
          allTriples={memory.graphTriples}
          nodeColors={nodeColors}
          onNavigate={handleNavigate}
          onClose={() => setSelectedUri(null)}
          contextGraphId={contextGraphId}
        />
      )}

      {/* ── Tab content ── */}
      {!memory.loading && hasData && !selectedEntity && (
        <>
          {activeTab === 'timeline' && (
            <TimelineView memory={memory} search={search} onSelect={handleSelect} />
          )}
          {activeTab === 'graph' && (
            <GraphView memory={memory} nodeColors={nodeColors} onNodeClick={handleNodeClick} />
          )}
          {activeTab === 'knowledge' && (
            <KnowledgeAssetsView memory={memory} search={search} onSelect={handleSelect} />
          )}
        </>
      )}

      {/* ── Empty state ── */}
      {!memory.loading && !hasData && (
        <div className="v10-me-empty">
          <div className="v10-me-empty-icon">⬡</div>
          <h2 className="v10-me-empty-title">No knowledge yet</h2>
          <p className="v10-me-empty-desc">
            Import files, chat with your agent, or connect an integration to start building this project's memory.
          </p>
          <button className="v10-modal-btn primary" onClick={() => setShowImport(true)}>↑ Import Files</button>
        </div>
      )}

      <ImportFilesModal
        open={showImport}
        onClose={() => setShowImport(false)}
        contextGraphId={cg.id}
        contextGraphName={cg.name}
      />
    </div>
  );
}
