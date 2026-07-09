import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Shared clipboard helper for the PCA surfaces. There is no app-wide
 * CopyButton (each surface inlined its own `navigator.clipboard?.writeText`),
 * so the PCA components — where a wallet/account address is copied in many
 * places — centralise it here. Clipboard failures (insecure context, denied
 * permission) are swallowed; the button just stays idle so the user can retry.
 */
export function useCopy(resetMs = 1200): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), resetMs);
        })
        .catch(() => {
          // clipboard unavailable; retain idle state.
        });
    },
    [resetMs],
  );

  return { copied, copy };
}

/**
 * A compact copy-to-clipboard icon button with a ≥24×24 hit area and a
 * polite live-region announcement. `label` is the accessible name (e.g.
 * "Copy address 0x…") so the control is meaningful out of visual context.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const { copied, copy } = useCopy();
  const accessibleName = copied ? 'Copied' : label;
  return (
    <>
      <button
        type="button"
        className={['v10-pca-copy-btn', className].filter(Boolean).join(' ')}
        onClick={() => copy(value)}
        aria-label={accessibleName}
        title={accessibleName}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
      <span className="v10-pca-copy-announce" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}
