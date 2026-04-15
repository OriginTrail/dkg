import React from 'react';
import type { MemoryEntity, TrustLevel } from '../../hooks/useMemoryEntities.js';
import { TrustBadge } from './TrustIndicator.js';

function shortPred(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  const raw = cut >= 0 ? uri.slice(cut + 1) : uri;
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

function shortType(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

const TRUST_DESCRIPTIONS: Record<TrustLevel, string> = {
  working: 'Draft — only in this agent\'s local working memory.',
  shared: 'Shared — proposed to collaborating agents via SWM.',
  verified: 'Verified — published on-chain with cryptographic provenance.',
};

interface EntityDetailProps {
  entity: MemoryEntity;
  onNavigate: (uri: string) => void;
  onClose: () => void;
}

export function EntityDetail({ entity, onNavigate, onClose }: EntityDetailProps) {
  return (
    <div className="v10-entity-detail">
      <div className="v10-entity-detail-header">
        <div className="v10-entity-detail-title-row">
          <h3 className="v10-entity-detail-title">{entity.label}</h3>
          <button className="v10-entity-detail-close" onClick={onClose}>×</button>
        </div>
        {entity.types.length > 0 && (
          <div className="v10-entity-detail-types">
            {entity.types.map(t => (
              <span key={t} className="v10-entity-detail-type-chip">{shortType(t)}</span>
            ))}
          </div>
        )}
        <div className="v10-entity-detail-uri mono">{entity.uri}</div>
      </div>

      <div className="v10-entity-detail-trust">
        <TrustBadge level={entity.trustLevel} showLabel />
        <span className="v10-entity-detail-trust-desc">
          {TRUST_DESCRIPTIONS[entity.trustLevel]}
        </span>
        {entity.layers.size > 1 && (
          <div className="v10-entity-detail-layers">
            Present in: {[...entity.layers].map(l => (
              <TrustBadge key={l} level={l} showLabel />
            ))}
          </div>
        )}
      </div>

      {entity.properties.size > 0 && (
        <div className="v10-entity-detail-section">
          <h4 className="v10-entity-detail-section-title">Properties</h4>
          <div className="v10-entity-detail-props">
            {[...entity.properties].map(([pred, vals]) => (
              <div key={pred} className="v10-entity-detail-prop">
                <span className="v10-entity-detail-prop-key">{shortPred(pred)}</span>
                <span className="v10-entity-detail-prop-val">
                  {vals.join(', ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {entity.connections.length > 0 && (
        <div className="v10-entity-detail-section">
          <h4 className="v10-entity-detail-section-title">
            Connections ({entity.connections.length})
          </h4>
          <div className="v10-entity-detail-connections">
            {entity.connections.map((conn, i) => (
              <button
                key={i}
                className="v10-entity-detail-conn"
                onClick={() => onNavigate(conn.targetUri)}
              >
                <span className="v10-entity-detail-conn-pred">{shortPred(conn.predicate)}</span>
                <span className="v10-entity-detail-conn-arrow">→</span>
                <span className="v10-entity-detail-conn-target">{conn.targetLabel}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
