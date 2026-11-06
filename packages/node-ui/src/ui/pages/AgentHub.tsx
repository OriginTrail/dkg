import React from 'react';
import { PanelRight } from '../components/Shell/PanelRight.js';
import { PageHeader } from '../components/ds/PageHeader.js';

export function AgentHubPage() {
  return (
    <div className="ds-page" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="Agent hub"
        description="Bring your own agent into the node. OpenClaw chat, network peers, and integrated-agent session history live here."
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-overlay)',
          overflow: 'hidden',
          background: 'var(--bg-root)',
        }}
      >
        <PanelRight />
      </div>
    </div>
  );
}
