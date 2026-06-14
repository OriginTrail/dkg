import React, { useState } from 'react';
import { useLayoutStore } from '../../stores/layout.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useCurrentAgent } from '../../hooks/useCurrentAgent.js';
import { NotificationsBell } from './NotificationsBell.js';
import { CuratorModelChatModal } from '../Modals/CuratorModelChatModal.js';
import { formatPeerStatusTooltip } from '../../lib/formatPeerStatus.js';

/** OriginTrail wordmark — same paths as `v9-stable` packages/node-ui App.tsx sidebar. */
const ORIGINTRAIL_WORDMARK = (
  <span className="v10-header-ot-wordmark">
    <svg width="60" height="13" viewBox="0 0 180 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M55.0428 28.0111C59.7903 28.0111 62.6388 24.531 62.6388 20.3908C62.6388 16.2806 59.7903 12.8005 55.0428 12.8005C50.325 12.8005 47.4766 16.2806 47.4766 20.3908C47.4766 24.531 50.325 28.0111 55.0428 28.0111ZM55.0428 24.621C52.6988 24.621 51.3932 22.6709 51.3932 20.3908C51.3932 18.1407 52.6988 16.1906 55.0428 16.1906C57.3869 16.1906 58.7221 18.1407 58.7221 20.3908C58.7221 22.6709 57.3869 24.621 55.0428 24.621Z" fill="currentColor" />
      <path d="M65.4344 27.6511H69.2027V18.0807C69.8258 17.1507 71.4874 16.4606 72.7336 16.4606C73.149 16.4606 73.5051 16.4906 73.7721 16.5507V12.8305C71.9918 12.8305 70.2115 13.8505 69.2027 15.1406V13.1605H65.4344V27.6511Z" fill="currentColor" />
      <path d="M77.9959 11.0304C79.2421 11.0304 80.251 10.0104 80.251 8.75031C80.251 7.49026 79.2421 6.47021 77.9959 6.47021C76.7794 6.47021 75.7409 7.49026 75.7409 8.75031C75.7409 10.0104 76.7794 11.0304 77.9959 11.0304ZM76.1266 27.6511H79.8949V13.1605H76.1266V27.6511Z" fill="currentColor" />
      <path d="M83.3347 31.3713C85.115 32.9614 87.0437 33.5314 89.5064 33.5314C93.0373 33.5314 97.2507 32.1813 97.2507 26.6611V13.1605H93.4527V15.0206C92.2955 13.5505 90.7526 12.8005 89.0317 12.8005C85.4117 12.8005 82.7116 15.4406 82.7116 20.1808C82.7116 25.011 85.4414 27.5611 89.0317 27.5611C90.7823 27.5611 92.3252 26.7211 93.4527 25.281V26.7511C93.4527 29.6012 91.3164 30.4113 89.5064 30.4113C87.6964 30.4113 86.1832 29.9012 85.026 28.6112L83.3347 31.3713ZM93.4527 22.5209C92.8296 23.4509 91.4647 24.171 90.2185 24.171C88.0822 24.171 86.5986 22.6709 86.5986 20.1808C86.5986 17.6907 88.0822 16.1906 90.2185 16.1906C91.4647 16.1906 92.8296 16.8807 93.4527 17.8407V22.5209Z" fill="currentColor" />
      <path d="M102.857 11.0304C104.104 11.0304 105.113 10.0104 105.113 8.75031C105.113 7.49026 104.104 6.47021 102.857 6.47021C101.641 6.47021 100.602 7.49026 100.602 8.75031C100.602 10.0104 101.641 11.0304 102.857 11.0304ZM100.988 27.6511H104.756V13.1605H100.988V27.6511Z" fill="currentColor" />
      <path d="M118.166 27.6511H121.934V17.4207C121.934 14.6006 120.421 12.8005 117.276 12.8005C114.932 12.8005 113.181 13.9405 112.261 15.0506V13.1605H108.493V27.6511H112.261V17.9007C112.884 17.0307 114.042 16.1906 115.525 16.1906C117.127 16.1906 118.166 16.8807 118.166 18.8908V27.6511Z" fill="currentColor" />
      <path d="M130.483 28.0111C132.055 28.0111 133.064 27.5911 133.628 27.0811L132.827 24.201C132.619 24.411 132.085 24.621 131.521 24.621C130.69 24.621 130.216 23.931 130.216 23.0309V16.4906H133.123V13.1605H130.216V9.20033H126.418V13.1605H124.044V16.4906H126.418V24.051C126.418 26.6311 127.842 28.0111 130.483 28.0111Z" fill="currentColor" />
      <path d="M135.702 27.6511H139.47V18.0807C140.093 17.1507 141.755 16.4606 143.001 16.4606C143.416 16.4606 143.772 16.4906 144.039 16.5507V12.8305C142.259 12.8305 140.479 13.8505 139.47 15.1406V13.1605H135.702V27.6511Z" fill="currentColor" />
      <path d="M156.245 27.6511H160.043V13.1605H156.245V15.0206C155.117 13.5505 153.515 12.8005 151.824 12.8005C148.174 12.8005 145.474 15.6806 145.474 20.4208C145.474 25.251 148.204 28.0111 151.824 28.0111C153.545 28.0111 155.117 27.2311 156.245 25.8211V27.6511ZM156.245 22.9709C155.592 23.931 154.257 24.621 152.981 24.621C150.845 24.621 149.361 22.9109 149.361 20.4208C149.361 17.9007 150.845 16.2206 152.981 16.2206C154.257 16.2206 155.592 16.9107 156.245 17.8707V22.9709Z" fill="currentColor" />
      <path d="M165.649 11.0304C166.895 11.0304 167.904 10.0104 167.904 8.75031C167.904 7.49026 166.895 6.47021 165.649 6.47021C164.432 6.47021 163.394 7.49026 163.394 8.75031C163.394 10.0104 164.432 11.0304 165.649 11.0304ZM163.78 27.6511H167.548V13.1605H163.78V27.6511Z" fill="currentColor" />
      <path d="M175.32 28.0111C176.863 28.0111 177.871 27.5911 178.435 27.0811L177.634 24.201C177.456 24.411 176.922 24.621 176.358 24.621C175.527 24.621 175.053 23.931 175.053 23.0309V7.64026H171.284V24.051C171.284 26.6311 172.679 28.0111 175.32 28.0111Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M19.781 9.94781C14.2903 9.94781 9.8385 14.4484 9.8385 20.0008C9.8385 25.5525 14.2903 30.0531 19.781 30.0531C22.833 30.0531 25.5632 28.6622 27.3869 26.4736L34.9141 32.8796C31.2855 37.2341 25.8532 40.0016 19.781 40.0016C8.85592 40.0016 0 31.0467 0 20.0008C0 8.95432 8.85592 0 19.781 0V9.94781ZM36.8737 30.0724L28.3719 25.0628C28.662 24.5606 28.9105 24.0308 29.112 23.4781L38.3464 26.9194C37.9453 28.0192 37.4508 29.0732 36.8737 30.0724ZM29.7216 20.0007H39.5609C39.5609 18.8159 39.4583 17.6554 39.2628 16.5272L29.5719 18.2549C29.6701 18.822 29.7216 19.4053 29.7216 20.0007ZM34.988 7.20831L27.425 13.5712C27.0546 13.1215 26.646 12.7054 26.2045 12.3272L32.5596 4.73338C33.4381 5.4858 34.251 6.31374 34.988 7.20831Z" fill="currentColor" />
    </svg>
  </span>
);

const SUN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

const MOON_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const SIDEBAR_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

const AGENT_PANEL_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
  </svg>
);

const SETTINGS_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const OBSERVABILITY_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

// Chat-bubble + spark — "Curator Model": chat with a curator's shared AI model.
const CURATOR_MODEL_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    <path d="M12 8.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </svg>
);

export function Header() {
  const { theme, setTheme, leftCollapsed, toggleLeft, rightCollapsed, toggleRight } = useLayoutStore();
  const nodeStatus = useAgentsStore((s) => s.nodeStatus);
  // Use the deduplicating shared hook (BUG-007): every other consumer
  // (Header, PanelRight, PanelLeft, modals, Dashboard's
  // useMyContextGraphs) used to fire its own `fetchCurrentAgent` on
  // mount AND poll independently. The shared hook coalesces all
  // mounts under a single in-flight promise + 60s polling cadence,
  // so the dashboard fan-out drops from ~14 calls in the first
  // second to one.
  const currentAgent = useCurrentAgent().data;
  const { openTab } = useTabsStore();
  // Curator Model chat is a global, cross-CG surface (it self-discovers every
  // CG this node is a member of), so it's launched here from the global header
  // rather than from a per-project view. The modal owns its own discovery +
  // in-memory chat session.
  const [showCuratorModel, setShowCuratorModel] = useState(false);

  const connectedPeers = nodeStatus?.connectedPeers ?? nodeStatus?.peerCount ?? 0;
  const directConns = nodeStatus?.connections?.direct ?? 0;
  const relayedConns = nodeStatus?.connections?.relayed ?? 0;
  const uptimeMs = nodeStatus?.uptimeMs ?? 0;
  const statusLoaded = nodeStatus != null;
  const synced = statusLoaded && nodeStatus?.synced !== false;
  const peerStatusLabel = formatPeerStatusTooltip(synced, connectedPeers, directConns, relayedConns, uptimeMs);

  return (
    <>
    <header className="v10-header">
      <div className="v10-header-logo">
        <span className="v10-header-logo-text">DKG <span className="v10-header-logo-version">v10</span></span>
        <div className="v10-header-logo-ot" aria-label="Powered by OriginTrail">
          <span className="v10-header-logo-ot-by">powered by</span>
          {ORIGINTRAIL_WORDMARK}
        </div>
      </div>

      <button
        className={`v10-header-icon-btn ${!leftCollapsed ? 'active-toggle' : ''}`}
        onClick={toggleLeft}
        title="Toggle sidebar"
      >
        {SIDEBAR_ICON}
      </button>

      <div className="v10-header-sep" />

      <div className="v10-header-agent-switcher" title={currentAgent ? `${currentAgent.agentDid}\n${currentAgent.agentAddress}` : undefined}>
        <span className="v10-header-agent-dot" />
        <span className="v10-header-agent-name">
          {(currentAgent?.name && currentAgent.name !== '**' ? currentAgent.name : null) || nodeStatus?.name || 'Agent'}
        </span>
        {currentAgent?.agentAddress && (
          <span className="v10-header-agent-addr">
            {currentAgent.agentAddress.slice(0, 6)}…{currentAgent.agentAddress.slice(-4)}
          </span>
        )}
      </div>

      <div className="v10-header-spacer" />

      <div className="v10-header-meta" title={peerStatusLabel}>
        <span className={`v10-header-status-dot ${synced ? 'online' : 'offline'}`} />
        <span>{synced ? 'synced' : 'syncing'}</span>
        <span className="v10-header-meta-sep">·</span>
        <span>{connectedPeers} peer{connectedPeers !== 1 ? 's' : ''}</span>
      </div>

      <div className="v10-header-actions">
        <NotificationsBell />

        <button
          className="v10-header-icon-btn"
          onClick={() => setShowCuratorModel(true)}
          title="Curator Model — chat with a curator's shared AI model"
        >
          {CURATOR_MODEL_ICON}
        </button>

        <button
          className="v10-header-icon-btn"
          onClick={() => openTab({ id: 'operations', label: 'Observability', closable: true })}
          title="Observability"
        >
          {OBSERVABILITY_ICON}
        </button>

        <button
          className="v10-header-icon-btn"
          onClick={() => openTab({ id: 'settings', label: 'Settings', closable: true })}
          title="Settings"
        >
          {SETTINGS_ICON}
        </button>

        <button
          className="v10-header-icon-btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? SUN_ICON : MOON_ICON}
        </button>

        <button
          className={`v10-header-icon-btn ${!rightCollapsed ? 'active-toggle' : ''}`}
          onClick={toggleRight}
          title="Toggle agent panel"
        >
          {AGENT_PANEL_ICON}
        </button>
      </div>
    </header>
    {/* Mount only while open so the modal's discovery hook (useMyContextGraphs
        → fetchContextGraphs poll) doesn't run on every Header mount. */}
    {showCuratorModel && (
      <CuratorModelChatModal open onClose={() => setShowCuratorModel(false)} />
    )}
    </>
  );
}
