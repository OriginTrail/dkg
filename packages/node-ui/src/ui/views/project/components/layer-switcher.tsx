import React, { useState, useEffect, useRef } from 'react';
import { type LayerView } from '../helpers.js';
import { Count, LayerGlyph } from '../../../components/ds/Badge.js';
import { FileCode, LayoutDashboard, MoreHorizontal, Network, RefreshCw, Share2, Upload } from 'lucide-react';

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
        className={`v10-layer-switch-btn ds-tab ${active === 'overview' ? 'active' : ''}`}
        data-layer="overview"
        aria-label="Overview"
        title="Overview"
        onClick={() => switchTo('overview')}
      >
        <span className="v10-layer-switch-icon"><LayoutDashboard size={14} /></span>
        <span className="v10-layer-switch-label">Overview</span>
      </button>
      <span className="v10-layer-switch-separator" aria-hidden="true" />
      <button
        className={`v10-layer-switch-btn ds-tab ${active === 'wm' ? 'active' : ''}`}
        data-layer="wm"
        aria-label="Working Memory"
        title="Working Memory"
        onClick={() => switchTo('wm')}
      >
        <span className="v10-layer-switch-icon"><LayerGlyph layer="wm" /></span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Working Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">WM</span>
        {counts.wm > 0 && <Count value={counts.wm} className="v10-layer-switch-count" />}
      </button>
      <button
        className={`v10-layer-switch-btn ds-tab ${active === 'swm' ? 'active' : ''}`}
        data-layer="swm"
        aria-label="Shared Working Memory"
        title="Shared Working Memory"
        onClick={() => switchTo('swm')}
      >
        <span className="v10-layer-switch-icon"><LayerGlyph layer="swm" /></span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Shared Working Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">SWM</span>
        {counts.swm > 0 && <Count value={counts.swm} className="v10-layer-switch-count" />}
      </button>
      <button
        className={`v10-layer-switch-btn ds-tab ${active === 'vm' ? 'active' : ''}`}
        data-layer="vm"
        aria-label="Verifiable Memory"
        title="Verifiable Memory"
        onClick={() => switchTo('vm')}
      >
        <span className="v10-layer-switch-icon"><LayerGlyph layer="vm" /></span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Verifiable Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">VM</span>
        {counts.vm > 0 && <Count value={counts.vm} className="v10-layer-switch-count" />}
      </button>
      <span className="v10-layer-switch-separator" aria-hidden="true" />
      <button
        className={`v10-layer-switch-btn ds-tab ${active === 'graph-overview' ? 'active' : ''}`}
        data-layer="graph-overview"
        aria-label="Subgraphs"
        title="Subgraphs"
        onClick={() => switchTo('graph-overview')}
      >
        <span className="v10-layer-switch-icon"><Network size={14} /></span>
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
          className={`v10-layer-switch-btn ds-tab v10-layer-more-btn ${active === 'query' ? 'active' : ''}`}
          data-layer="query"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label="More context graph views"
          title="More context graph views"
          onClick={() => setMoreOpen(open => !open)}
        >
          <span className="v10-layer-switch-icon"><MoreHorizontal size={14} /></span>
          <span className="v10-layer-switch-label">More</span>
        </button>
        {moreOpen && (
          <div className="v10-layer-more-menu ds-card-nested" role="menu">
            <button
              type="button"
              role="menuitem"
              className={`v10-layer-more-item ${active === 'query' ? 'active' : ''}`}
              onClick={() => switchTo('query')}
            >
              <span className="v10-layer-switch-icon">⟐</span>
              Query catalogue
            </button>
          </div>
        )}
      </div>
      <div className="v10-layer-switcher-spacer" />
      <div className="v10-layer-switcher-actions">
        {onNewProgram && (
          <button className="v10-layer-action-btn ds-btn ds-sm" onClick={onNewProgram} aria-label="New TypeScript Program">
            <span className="v10-layer-action-icon"><FileCode size={12} /></span>
            <span className="v10-layer-action-label">Program</span>
          </button>
        )}
        <button className="v10-layer-action-btn ds-btn ds-sm" onClick={onShare} aria-label="Share context graph">
          <span className="v10-layer-action-icon"><Share2 size={12} /></span>
          <span className="v10-layer-action-label">Share</span>
        </button>
        <button className="v10-layer-action-btn ds-btn ds-sm" onClick={onImport} aria-label="Import into context graph">
          <span className="v10-layer-action-icon"><Upload size={12} /></span>
          <span className="v10-layer-action-label">Import</span>
        </button>
        <button className="v10-layer-action-btn ds-btn ds-sm" onClick={onRefresh} aria-label="Refresh context graph data">
          <span className="v10-layer-action-icon"><RefreshCw size={12} /></span>
        </button>
      </div>
    </div>
  );
}
