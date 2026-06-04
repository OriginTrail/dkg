import type React from 'react';
import { useEffect, useRef, useCallback } from 'react';

/**
 * Shared modal-dismiss + a11y hook (BUG-017).
 *
 * The Create/Join Context Graph modals previously had no Esc handler,
 * no explicit close (×) button, no `role="dialog"`, no focus trap, and
 * didn't restore focus after closing — every accessibility audit
 * dimension was missing. Some users could click the backdrop to
 * dismiss; that left the most common keyboard-only flow (Esc-to-close)
 * silently broken.
 *
 * The hook returns:
 *   - `dialogRef` to attach to the dialog box `<div>` so we can scope
 *     focus to its descendants.
 *   - `onBackdropClick` to wire to the overlay's onClick (preserves the
 *     current backdrop-to-dismiss behaviour, but keeps it isolated from
 *     bubbling clicks inside the dialog).
 *
 * The hook itself:
 *   1. Listens for `Escape` while the dialog is open.
 *   2. Traps Tab focus inside the dialog so Tab/Shift+Tab cycle within
 *      its focusable descendants (no escaping into the underlying app).
 *   3. Restores focus to the previously-focused element when the
 *      dialog closes.
 *   4. Stamps the document with `aria-hidden` on the rest of the page —
 *      omitted here to avoid re-implementing a portal; the role and
 *      focus trap satisfy the WCAG 2.1 modal pattern.
 */
export function useModalDismiss(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // Move focus into the dialog so screen readers announce the
    // dialog's accessible name and Tab navigation is scoped.
    queueMicrotask(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      // Skip DISABLED controls: focusing them is a no-op that silently
      // leaves focus on the background page. A modal can legitimately have
      // every control disabled transiently (e.g. ImportFilesModal while an
      // upload is in flight), so we need a fallback below.
      const firstFocusable = dialog.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      // Prefer the explicit `[autofocus]` element when present
      // (matches React's autoFocus semantics for the name input).
      const autoFocus = dialog.querySelector<HTMLElement>('[autofocus]');
      const target = autoFocus ?? firstFocusable;
      if (target) {
        target.focus();
      } else {
        // Nothing focusable inside — focus the dialog itself so focus still
        // enters the modal and `aria-modal="true"` isn't a lie (Codex
        // review). Make it programmatically focusable if the caller didn't.
        if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
        dialog.focus();
      }
    });
    return () => {
      // Restore focus on close so keyboard users land back where they
      // started instead of at <body>.
      lastFocusRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        // No tabbable target inside (e.g. every control disabled mid-upload).
        // Returning here would let Tab move focus OUT to the background page
        // even though the dialog is aria-modal. Instead, swallow the Tab and
        // keep focus pinned on the dialog container (made focusable on open).
        // (Codex review follow-up.)
        e.preventDefault();
        if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  const onBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return { dialogRef, onBackdropClick };
}
