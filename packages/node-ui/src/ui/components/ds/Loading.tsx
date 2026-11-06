/**
 * Loading: says what is loading, with a spinner, and tells screen readers.
 * `block` centres it in the space a view or panel is about to fill.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';

export interface LoadingProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** What the reader is waiting for, such as "Loading peers…". */
  label: React.ReactNode;
  block?: boolean;
}

export const Loading: React.FC<LoadingProps> = ({ label, block, className, ...rest }) => (
  <span role="status" className={['ds-loading', block && 'ds-block', className].filter(Boolean).join(' ')} {...rest}>
    <Loader2 size={14} className="ds-spin" />
    {label}
  </span>
);
