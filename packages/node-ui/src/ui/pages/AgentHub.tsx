import React from 'react';
import { PanelRight } from '../components/Shell/PanelRight.js';

export function AgentHubPage() {
  return (
    <div className="page-section" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Agent Hub</h1>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          Bring your own agent into the node. OpenClaw chat, network peers, and integrated-agent session history live here.
        </p>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--bg)',
        }}
      >
        <PanelRight />
      </div>
    </div>
  );
}
