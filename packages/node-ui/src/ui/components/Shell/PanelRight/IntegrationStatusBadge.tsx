import React from 'react';
import type { LocalAgentIntegrationStatus } from '../../../api.js';
import { Badge, type BadgeTone } from '../../ds/Badge.js';
import { humanizeStatus } from '../../../lib/formatLabels.js';

/** Signal colour for a local agent integration: ready is green, a bridge
 *  that's down or degraded is amber, everything else stays neutral. */
export function integrationStatusTone(status: LocalAgentIntegrationStatus): BadgeTone {
  if (status === 'chat_ready') return 'success';
  if (status === 'bridge_offline' || status === 'degraded') return 'warning';
  return 'neutral';
}

/** The status pill on a local agent integration card. */
export function IntegrationStatusBadge({ status, label }: { status: LocalAgentIntegrationStatus; label: string }) {
  return (
    <Badge size="sm" tone={integrationStatusTone(status)} className={`v10-local-agent-status-pill ${status}`}>
      {humanizeStatus(String(label))}
    </Badge>
  );
}
