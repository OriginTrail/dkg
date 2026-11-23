import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from './Button.js';

/**
 * The one Retry control (DESIGN.md · Feedback states). It sits outside the message it belongs to,
 * with the refresh icon.
 * Small by default; `md` where it sits beside a default-size button.
 */
export function RetryButton({
  onClick,
  size = 'sm',
  className,
}: {
  onClick: () => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <Button size={size} className={className} onClick={onClick}>
      <RefreshCw size={size === 'sm' ? 12 : 14} aria-hidden="true" />Retry
    </Button>
  );
}
