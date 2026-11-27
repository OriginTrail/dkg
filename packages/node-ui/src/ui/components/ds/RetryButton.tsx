import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './Button.js';

/**
 * The one Retry control (DESIGN.md · Feedback states). It says "Retry", with the refresh icon,
 * and sits outside the message it belongs to: below it, or beside it in a `ds-retry-row`.
 * The message says what failed. Small by default; `md` where it sits beside a default-size button.
 */
export function RetryButton({
  onClick,
  size = 'sm',
  className,
  disabled,
  ...rest
}: {
  onClick: () => void;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
} & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-describedby'> & { 'data-testid'?: string }) {
  return (
    <Button size={size} className={className} onClick={onClick} disabled={disabled} {...rest}>
      <RefreshCw size={size === 'sm' ? 12 : 14} aria-hidden="true" />Retry
    </Button>
  );
}
