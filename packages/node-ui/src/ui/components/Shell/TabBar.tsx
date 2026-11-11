/**
 * The centre tab bar (DESIGN.md · Navigation). Tabs behave like browser tabs:
 * marks show what each tab is, Dashboard is pinned first, tabs reorder by
 * drag or Ctrl+Shift+←/→, close with ×, middle-click or the context menu,
 * and the ⌄ menu lists every open tab plus recently closed ones.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTabsStore, type CenterTab } from '../../stores/tabs.js';
import { ContextGraphMark } from '../../context-graph-colors.js';
import { useProjectsStore } from '../../stores/projects.js';
import { decodeTabId } from '../../lib/tab-target.js';
import { chooseOpenTab } from '../../lib/shellNavigation.js';
import { AgentDot } from '../AgentDot.js';
import { CHEVRON_DOWN, CLOSE_ICON, FILE_ICON, placeIcon } from './nav-icons.js';

export function TabMark({ tab, label }: { tab: CenterTab; label?: string }) {
  const t = decodeTabId(tab.id);
  switch (t.kind) {
    case 'graph': return <ContextGraphMark id={t.contextGraphId} name={label ?? tab.label} />;
    case 'agent': return <AgentDot uri={t.slug} label={(label ?? tab.label).replace(/^@\s*/, '')} size={16} />;
    case 'conviction': return <span className="v10-tab-mark-icon">{placeIcon('conviction')}</span>;
    case 'document': return <span className="v10-tab-mark-icon">{FILE_ICON}</span>;
    case 'layer': return <span className="v10-tab-mark-icon">{placeIcon('memory-stack')}</span>;
    case 'place': { const icon = placeIcon(t.id); return icon ? <span className="v10-tab-mark-icon">{icon}</span> : null; }
    default: return null;
  }
}

/** A graph tab shows the graph's current name from the inventory; the saved
 *  label (a short id until the list loads) is the fallback. */
export function useTabLabels(): (tab: CenterTab) => string {
  const graphs = useProjectsStore((s) => s.contextGraphs);
  const names = useMemo(() => new Map(graphs.map((g) => [g.id, g.name])), [graphs]);
  return useCallback((tab: CenterTab) => {
    const t = decodeTabId(tab.id);
    return (t.kind === 'graph' && names.get(t.contextGraphId)) || tab.label;
  }, [names]);
}

type Menu = { kind: 'context'; id: string; x: number; y: number } | { kind: 'all'; x: number; y: number } | null;

export function TabBar() {
  const { tabs, activeTabId, recentlyClosed, setActiveTab, closeTab, moveTab, closeOtherTabs, closeTabsToRight, reopenTab } = useTabsStore();
  const labelOf = useTabLabels();
  const [menu, setMenu] = useState<Menu>(null);
  const [drag, setDrag] = useState<{ id: string; over?: string; side?: 'before' | 'after' } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    barRef.current?.querySelector<HTMLElement>('.v10-center-tab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const focusActive = () => requestAnimationFrame(() => barRef.current?.querySelector<HTMLElement>('.v10-center-tab.active')?.focus());

  const onKeyDown = (e: React.KeyboardEvent, tab: CenterTab, index: number) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      moveTab(tab.id, index + (e.key === 'ArrowLeft' ? -1 : 1));
      focusActive();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = tabs[(index + (e.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
      setActiveTab(next.id);
      focusActive();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && tab.closable) {
      e.preventDefault();
      closeTab(tab.id);
      focusActive();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      chooseOpenTab(tab.id);
    }
  };

  const contextTab = menu?.kind === 'context' ? tabs.find((t) => t.id === menu.id) : undefined;
  const contextIndex = contextTab ? tabs.indexOf(contextTab) : -1;

  return (
    <div className="v10-center-tabbar">
      <div className="v10-center-tabs" role="tablist" aria-label="Open tabs" ref={barRef}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const pinned = !tab.closable;
          const dropClass = drag && drag.over === tab.id && drag.id !== tab.id ? ` drop-${drag.side}` : '';
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              aria-keyshortcuts={tab.closable ? 'Delete' : undefined}
              tabIndex={active ? 0 : -1}
              className={`v10-center-tab${active ? ' active' : ''}${pinned ? ' pinned' : ''}${drag?.id === tab.id ? ' dragging' : ''}${dropClass}`}
              title={labelOf(tab)}
              draggable={!pinned}
              onClick={() => chooseOpenTab(tab.id)}
              onKeyDown={(e) => onKeyDown(e, tab, index)}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => { if (e.button === 1 && tab.closable) { e.preventDefault(); closeTab(tab.id); } }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'context', id: tab.id, x: e.clientX, y: e.clientY }); }}
              onDragStart={(e) => { setDrag({ id: tab.id }); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', tab.id); } catch { /* some browsers */ } }}
              onDragOver={(e) => {
                if (!drag || pinned) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
                if (drag.over !== tab.id || drag.side !== side) setDrag({ ...drag, over: tab.id, side });
              }}
              onDrop={(e) => {
                if (!drag || pinned) return;
                e.preventDefault();
                const from = tabs.findIndex((t) => t.id === drag.id);
                let to = index + (drag.side === 'after' ? 1 : 0);
                if (from < to) to -= 1;
                moveTab(drag.id, to);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              <TabMark tab={tab} label={labelOf(tab)} />
              {!pinned && <span className="v10-center-tab-label">{labelOf(tab)}</span>}
              {pinned && <span className="v10-sr-only">{labelOf(tab)}</span>}
              {tab.closable && (
                // A mouse shortcut only: a control can't sit inside a tab. Keyboard
                // and screen reader users close with Delete (aria-keyshortcuts).
                <span
                  className="v10-center-tab-close"
                  aria-hidden="true"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                >
                  {CLOSE_ICON}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="v10-center-tabs-all"
        aria-haspopup="menu"
        aria-expanded={menu?.kind === 'all'}
        title="All open tabs and recently closed"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu?.kind === 'all' ? null : { kind: 'all', x: r.right, y: r.bottom + 4 });
        }}
      >
        {CHEVRON_DOWN}<span className="v10-center-tabs-count">{tabs.length}</span>
      </button>

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="v10-tab-menu"
          style={menu.kind === 'all'
            ? { top: menu.y, right: Math.max(8, window.innerWidth - menu.x) }
            : { top: Math.min(menu.y, window.innerHeight - 140), left: Math.min(menu.x, window.innerWidth - 240) }}
        >
          {menu.kind === 'context' && contextTab && (
            <>
              <button role="menuitem" className="v10-tab-menu-item" disabled={!contextTab.closable} onClick={() => { closeTab(contextTab.id); setMenu(null); }}>
                Close<span className="v10-tab-menu-hint">middle-click</span>
              </button>
              <button role="menuitem" className="v10-tab-menu-item" disabled={tabs.filter((t) => t.closable && t.id !== contextTab.id).length === 0} onClick={() => { closeOtherTabs(contextTab.id); setMenu(null); }}>
                Close others
              </button>
              <button role="menuitem" className="v10-tab-menu-item" disabled={contextIndex >= tabs.length - 1} onClick={() => { closeTabsToRight(contextTab.id); setMenu(null); }}>
                Close to the right
              </button>
            </>
          )}
          {menu.kind === 'all' && (
            <>
              <div className="v10-tab-menu-label">Open tabs</div>
              {tabs.map((tab) => (
                <button key={tab.id} role="menuitem" className={`v10-tab-menu-item${tab.id === activeTabId ? ' active' : ''}`} onClick={() => { chooseOpenTab(tab.id); setMenu(null); }}>
                  <TabMark tab={tab} label={labelOf(tab)} /><span className="v10-tab-menu-text">{labelOf(tab)}</span>
                  {tab.id === activeTabId && <span className="v10-tab-menu-hint">active</span>}
                </button>
              ))}
              <div className="v10-tab-menu-sep" />
              <div className="v10-tab-menu-label">Recently closed</div>
              {recentlyClosed.length === 0 && <div className="v10-tab-menu-empty">Nothing closed yet</div>}
              {recentlyClosed.map((tab) => (
                <button key={tab.id} role="menuitem" className="v10-tab-menu-item" onClick={() => { reopenTab(tab.id); setMenu(null); }}>
                  <TabMark tab={tab} label={labelOf(tab)} /><span className="v10-tab-menu-text">{labelOf(tab)}</span><span className="v10-tab-menu-hint">reopen</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
