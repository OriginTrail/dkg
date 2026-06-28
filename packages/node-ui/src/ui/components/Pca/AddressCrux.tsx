import React, { useId } from 'react';
import type { ReactNode } from 'react';

/**
 * The single most important copy in the feature (UX §5.4 step 1): which address
 * to approve. Used by S4 (sponsor input) and the S3 Probe Wallet tool. Always
 * carries the identity-disambiguation ("operational wallet that signs publishes
 * — NOT peerId/admin/author") and the ERC-20 `approve()` disambiguation, so the
 * #1 footgun (approving the wrong address) is guarded wherever the input lives.
 */
export const DEFAULT_ADDRESS_CRUX_NOTE: ReactNode = (
  <>
    Paste the <strong>operational wallet address</strong> — the address that signs its publish
    transactions (on-chain <code>msg.sender</code>). <strong>NOT</strong> its peerId.{' '}
    <strong>NOT</strong> its admin wallet. <strong>NOT</strong> a content-author identity. The
    other operator gets these from <code>dkg wallet</code>, or from their node's{' '}
    <em>Get sponsored</em> panel.
  </>
);

export function AddressCrux({
  value,
  onChange,
  mode = 'single',
  label = 'Operational wallet (the address that signs publishes)',
  cruxNote = DEFAULT_ADDRESS_CRUX_NOTE,
  placeholder,
  error,
  disabled = false,
  rows = 5,
  id,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  /** `bulk` renders a textarea (S4 sponsor, one 0x address per line). */
  mode?: 'single' | 'bulk';
  label?: ReactNode;
  /** The identity-disambiguation copy; pass `null` to omit. */
  cruxNote?: ReactNode;
  placeholder?: string;
  error?: ReactNode;
  disabled?: boolean;
  rows?: number;
  id?: string;
  className?: string;
}) {
  const autoId = useId();
  const inputId = id ?? `pca-addr-${autoId}`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const describedBy = [error ? errorId : null, helpId].filter(Boolean).join(' ') || undefined;
  const fallbackPlaceholder = mode === 'bulk' ? '0x… (one per line)' : '0x…';

  return (
    <div className={['v10-pca-address-crux', className].filter(Boolean).join(' ')}>
      <label className="v10-form-label" htmlFor={inputId}>
        {label}
      </label>
      {cruxNote != null && <p className="v10-pca-crux-note">{cruxNote}</p>}
      {mode === 'bulk' ? (
        <textarea
          id={inputId}
          className="v10-form-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? fallbackPlaceholder}
          disabled={disabled}
          rows={rows}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          spellCheck={false}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          className="v10-form-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? fallbackPlaceholder}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          autoComplete="off"
        />
      )}
      <p id={helpId} className="v10-pca-crux-help">
        <abbr title="On-chain authorization to publish under this account — unrelated to the ERC-20 token approve() that grants a spending allowance.">
          “Approve”
        </abbr>{' '}
        is on-chain authorization to publish under this account — unrelated to ERC-20 token{' '}
        <code>approve()</code>. The wallet owner doesn't sign anything.
      </p>
      {error != null && (
        <p id={errorId} className="v10-pca-crux-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
