import React from 'react';
import { Badge, type BadgeTone } from './ds/Badge.js';
import { humanizeStatus } from '../lib/formatLabels.js';

/**
 * How an operation's status reads, wherever operations are listed: the
 * Observability Operations view and the bottom panel's Transactions.
 */
export function operationStatusTone(status: string): BadgeTone {
  if (status === 'success') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'cancelled') return 'muted';
  return 'pending';
}

/** The word shown for an operation status: the same Done and Failed as nOS. */
export function operationStatusLabel(status: string): string {
  if (status === 'success') return 'Done';
  if (status === 'error') return 'Failed';
  return humanizeStatus(status);
}

export function OperationStatusBadge({ status }: { status: string }) {
  return <Badge size="sm" tone={operationStatusTone(status)}>{operationStatusLabel(status)}</Badge>;
}
