import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { LocalAgentIntegration } from '../../../api.js';

export function bridgeStatusDotClass(integration: LocalAgentIntegration): string {
  if (integration.bridgeOnline) return 'connected';
  if (integration.status === 'connecting') return 'known';
  if (integration.status === 'degraded') return 'degraded';
  return 'offline';
}

export function localAgentToolbarLabel(
  integration: LocalAgentIntegration,
  showingSessionHistory: boolean,
): string {
  if (showingSessionHistory) {
    return 'Session history';
  }
  if (integration.chatReady) {
    return `${integration.name} connected`;
  }
  if (integration.status === 'connecting') {
    return `${integration.name} is connecting…`;
  }
  if (integration.status === 'degraded') {
    return `${integration.name} degraded`;
  }
  return `${integration.name} is unavailable`;
}

export function AgentTabMenu(props: {
  integration: LocalAgentIntegration;
  statusLabel: string;
  statusDotClass: string;
  refreshBusy: boolean;
  canDisconnect: boolean;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Default left-anchored. After the popover opens we measure whether it
  // would overflow the panel's right edge (rightmost agent tabs on narrow
  // layouts) and flip to right-anchored if so.
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (!popover || !trigger) return;
    // Find the nearest scroll/panel container — the right-side chat panel
    // is the visible boundary the popover must fit inside. Fall back to
    // the viewport width when there is no panel ancestor.
    const panel = trigger.closest<HTMLElement>('.v10-panel-right') || document.body;
    const panelRect = panel.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    // Compute where the (left-anchored) popover's right edge would land.
    // popover.offsetWidth already reflects min-width: 200px, even right
    // after open when alignRight is still false on the first paint.
    const projectedRight = triggerRect.left + popover.offsetWidth;
    if (projectedRight > panelRect.right - 4) {
      setAlignRight(true);
    } else {
      setAlignRight(false);
    }
  }, [open]);

  const closeAndReturnFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAndReturnFocus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeAndReturnFocus]);

  // Focus first menuitem when popover opens (ARIA APG menu-button pattern).
  useEffect(() => {
    if (!open) return;
    const firstItem = popoverRef.current?.querySelector<HTMLButtonElement>(
      '.v10-agent-tab-menu-item:not(:disabled)',
    );
    firstItem?.focus();
  }, [open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPopoverKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Let tab close the menu so focus falls through naturally.
      setOpen(false);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>(
        '.v10-agent-tab-menu-item:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.findIndex((el) => el === document.activeElement);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex === -1
      ? (delta === 1 ? 0 : items.length - 1)
      : (currentIndex + delta + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div className="v10-agent-tab-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="v10-agent-tab-menu-trigger"
        aria-label={`More actions for ${props.integration.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`More actions for ${props.integration.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <MoreHorizontal aria-hidden="true" size={14} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className={`v10-agent-tab-menu-popover${alignRight ? ' align-right' : ''}`}
          role="menu"
          onKeyDown={onPopoverKeyDown}
        >
          <div className="v10-agent-tab-menu-status" aria-hidden="true">
            <span className={`v10-agents-stat-dot ${props.statusDotClass}`} />
            <span>{props.statusLabel}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="v10-agent-tab-menu-item"
            disabled={props.refreshBusy}
            onClick={() => {
              closeAndReturnFocus();
              props.onRefresh();
            }}
          >
            {props.refreshBusy ? 'Refreshing…' : 'Refresh'}
          </button>
          {props.canDisconnect && (
            <button
              type="button"
              role="menuitem"
              className="v10-agent-tab-menu-item danger"
              onClick={() => {
                closeAndReturnFocus();
                props.onDisconnect();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
