import React, { useState, useEffect, useRef } from 'react';
import { type LayerView } from '../helpers.js';

export function LayerSwitcher({ active, counts, onSwitch, onShare, onImport, onRefresh, onNewProgram }: {
  active: LayerView;
  counts: { wm: number; swm: number; vm: number; total: number };
  onSwitch: (v: LayerView) => void;
  onShare: () => void;
  onImport: () => void;
  onRefresh: () => void;
  onNewProgram?: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const switchTo = (layer: LayerView) => {
    setMoreOpen(false);
    onSwitch(layer);
  };

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && moreRef.current?.contains(target)) return;
      setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [moreOpen]);

  return (
    <div className="v10-layer-switcher">
      <button
        className={`v10-layer-switch-btn ${active === 'overview' ? 'active' : ''}`}
        data-layer="overview"
        aria-label="Overview"
        title="Overview"
        onClick={() => switchTo('overview')}
      >
        <span className="v10-layer-switch-icon">◎</span>
        <span className="v10-layer-switch-label">Overview</span>
      </button>
      <span className="v10-layer-switch-separator" aria-hidden="true" />
      <button
        className={`v10-layer-switch-btn ${active === 'wm' ? 'active' : ''}`}
        data-layer="wm"
        aria-label="Working Memory"
        title="Working Memory"
        onClick={() => switchTo('wm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#64748b' }}>◇</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Working Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">WM</span>
        {counts.wm > 0 && <span className="v10-layer-switch-count">{counts.wm}</span>}
      </button>
      <button
        className={`v10-layer-switch-btn ${active === 'swm' ? 'active' : ''}`}
        data-layer="swm"
        aria-label="Shared Working Memory"
        title="Shared Working Memory"
        onClick={() => switchTo('swm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#f59e0b' }}>◈</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Shared Working Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">SWM</span>
        {counts.swm > 0 && <span className="v10-layer-switch-count">{counts.swm}</span>}
      </button>
      <button
        className={`v10-layer-switch-btn ${active === 'vm' ? 'active' : ''}`}
        data-layer="vm"
        aria-label="Verifiable Memory"
        title="Verifiable Memory"
        onClick={() => switchTo('vm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#22c55e' }}>◉</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Verifiable Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">VM</span>
        {counts.vm > 0 && <span className="v10-layer-switch-count">{counts.vm}</span>}
      </button>
      <span className="v10-layer-switch-separator" aria-hidden="true" />
      <button
        className={`v10-layer-switch-btn ${active === 'graph-overview' ? 'active' : ''}`}
        data-layer="graph-overview"
        aria-label="Subgraphs"
        title="Subgraphs"
        onClick={() => switchTo('graph-overview')}
      >
        <span className="v10-layer-switch-icon">⌬</span>
        <span className="v10-layer-switch-label">Subgraphs</span>
      </button>
      <div
        ref={moreRef}
        className="v10-layer-more"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setMoreOpen(false);
          }
        }}
      >
        <button
          type="button"
          className={`v10-layer-switch-btn v10-layer-more-btn ${active === 'query' ? 'active' : ''}`}
          data-layer="query"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label="More Context Graph views"
          title="More Context Graph views"
          onClick={() => setMoreOpen(open => !open)}
        >
          <span className="v10-layer-switch-icon">⋯</span>
          <span className="v10-layer-switch-label">More</span>
        </button>
        {moreOpen && (
          <div className="v10-layer-more-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className={`v10-layer-more-item ${active === 'query' ? 'active' : ''}`}
              onClick={() => switchTo('query')}
            >
              <span className="v10-layer-switch-icon">⟐</span>
              Query Catalogue
            </button>
          </div>
        )}
      </div>
      <div className="v10-layer-switcher-spacer" />
      <div className="v10-layer-switcher-actions">
        {onNewProgram && <button className="v10-layer-action-btn" onClick={onNewProgram} aria-label="New TypeScript Program">
          <span className="v10-layer-action-icon">⌘</span><span className="v10-layer-action-label">Program</span>
        </button>}
        <button className="v10-layer-action-btn" onClick={onShare} aria-label="Share Context Graph">
          <span className="v10-layer-action-icon">⤴</span>
          <span className="v10-layer-action-label">Share</span>
        </button>
        <button className="v10-layer-action-btn" onClick={onImport} aria-label="Import into Context Graph">
          <span className="v10-layer-action-icon">↑</span>
          <span className="v10-layer-action-label">Import</span>
        </button>
        <button className="v10-layer-action-btn" onClick={onRefresh} aria-label="Refresh Context Graph data">
          <span className="v10-layer-action-icon">↻</span>
        </button>
      </div>
    </div>
  );
}
