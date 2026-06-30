import React, { useCallback, useEffect, useRef } from 'react';
import { useModalDismiss } from '../../components/Modals/useModalDismiss.js';

/**
 * Shared modal chrome for the PCA dialogs (S2 Create, S4 Approve) — mirrors
 * `CreateProjectModal`'s overlay/box/header markup + `useModalDismiss` (Esc +
 * focus-trap + restore), and moves focus to the heading on open (DRIFT-2
 * heading-focus-on-open). Mount conditionally (`{open && <…/>}`) so each open
 * gets fresh state.
 */
export function PcaModalShell({
  onClose,
  title,
  subtitle,
  testId,
  children,
  dismissDisabled = false,
}: {
  onClose: () => void;
  title: string;
  subtitle?: string;
  testId?: string;
  children: React.ReactNode;
  dismissDisabled?: boolean;
}) {
  const handleClose = useCallback(() => {
    if (!dismissDisabled) onClose();
  }, [dismissDisabled, onClose]);
  const { dialogRef, onBackdropClick } = useModalDismiss(true, handleClose);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    // F4/L7: useModalDismiss (called above, so its effect runs first) focuses the
    // first focusable — the Close × — in a microtask on open. A synchronous
    // focus here would be immediately overridden by that microtask. Queue ours in
    // a microtask too; because this effect runs AFTER the hook's, ours is enqueued
    // later and wins, so the dialog HEADING is what a screen reader announces.
    queueMicrotask(() => headingRef.current?.focus());
  }, []);

  return (
    <div className="v10-modal-overlay" onClick={onBackdropClick} role="presentation">
      <div
        className="v10-modal-box v10-pca-modal-box"
        data-testid={testId}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pca-modal-title"
      >
        <button
          type="button"
          className="v10-modal-close"
          onClick={handleClose}
          aria-label={dismissDisabled ? 'Close disabled while signing' : 'Close dialog'}
          title={dismissDisabled ? 'Finish or reject the wallet prompt first' : 'Close (Esc)'}
          disabled={dismissDisabled}
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: dismissDisabled ? 'not-allowed' : 'pointer', fontSize: 18, lineHeight: 1, padding: 4, zIndex: 1, opacity: dismissDisabled ? 0.45 : 1 }}
        >
          ×
        </button>
        <div className="v10-modal-header">
          <h2 id="pca-modal-title" className="v10-modal-title" tabIndex={-1} ref={headingRef}>
            {title}
          </h2>
          {subtitle && <div className="v10-modal-subtitle">{subtitle}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
