import React, { useState, useMemo } from 'react';
import type { MemoryEntity } from '../../hooks/useMemoryEntities.js';
import { TrustBadge } from './TrustIndicator.js';

function shortType(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

const TYPE_ICONS: Record<string, string> = {
  Person: '👤', Organization: '🏢', Place: '📍', Product: '📦',
  CreativeWork: '📄', Event: '📅', Thing: '◆', SoftwareSourceCode: '💻',
  Message: '💬', Conversation: '💭', Action: '⚡',
};

function typeIcon(types: string[]): string {
  for (const t of types) {
    const short = shortType(t);
    if (TYPE_ICONS[short]) return TYPE_ICONS[short];
  }
  return '◆';
}

interface EntityListProps {
  entities: MemoryEntity[];
  selectedUri: string | null;
  onSelect: (uri: string) => void;
}

export function EntityList({ entities, selectedUri, onSelect }: EntityListProps) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const typeGroups = useMemo(() => {
    const groups = new Map<string, number>();
    for (const e of entities) {
      const primary = e.types[0] ? shortType(e.types[0]) : 'Unknown';
      groups.set(primary, (groups.get(primary) ?? 0) + 1);
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }, [entities]);

  const filtered = useMemo(() => {
    let list = entities;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        e.label.toLowerCase().includes(q) ||
        e.uri.toLowerCase().includes(q) ||
        e.types.some(t => shortType(t).toLowerCase().includes(q))
      );
    }
    if (typeFilter) {
      list = list.filter(e => e.types.some(t => shortType(t) === typeFilter));
    }
    return list;
  }, [entities, search, typeFilter]);

  return (
    <div className="v10-entity-list">
      <div className="v10-entity-list-search">
        <input
          type="text"
          className="v10-entity-search-input"
          placeholder="Search entities..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {typeGroups.length > 1 && (
        <div className="v10-entity-type-filters">
          <button
            className={`v10-entity-type-chip ${typeFilter === null ? 'active' : ''}`}
            onClick={() => setTypeFilter(null)}
          >
            All ({entities.length})
          </button>
          {typeGroups.map(([type, count]) => (
            <button
              key={type}
              className={`v10-entity-type-chip ${typeFilter === type ? 'active' : ''}`}
              onClick={() => setTypeFilter(typeFilter === type ? null : type)}
            >
              {TYPE_ICONS[type] ?? '◆'} {type} ({count})
            </button>
          ))}
        </div>
      )}

      <div className="v10-entity-items">
        {filtered.map(entity => (
          <button
            key={entity.uri}
            className={`v10-entity-item ${selectedUri === entity.uri ? 'selected' : ''}`}
            onClick={() => onSelect(entity.uri)}
          >
            <span className="v10-entity-item-icon">{typeIcon(entity.types)}</span>
            <div className="v10-entity-item-info">
              <span className="v10-entity-item-label">{entity.label}</span>
              <span className="v10-entity-item-type">
                {entity.types.map(shortType).join(', ') || 'Entity'}
                {entity.connections.length > 0 && ` · ${entity.connections.length} links`}
              </span>
            </div>
            <TrustBadge level={entity.trustLevel} />
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="v10-entity-list-empty">
            {search ? 'No entities match your search.' : 'No entities found.'}
          </div>
        )}
      </div>
    </div>
  );
}
