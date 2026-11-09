import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ds/Button.js';

/**
 * The one Retry control on PCA screens. It sits outside the message it belongs to.
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
