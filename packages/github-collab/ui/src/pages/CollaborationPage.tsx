import React, { useState, useEffect, useCallback } from 'react';
import { useRepo, repoKey } from '../context/RepoContext.js';
import {
  fetchInfo,
  convertToShared,
  sendInvitation,
  fetchInvitations,
  acceptInvitation,
  declineInvitation,
  revokeInvitation,
  fetchCollaborators,
} from '../api.js';

// --- Types ---

interface Invitation {
  invitationId: string;
  repoKey: string;
  paranetId: string;
  fromPeerId: string;
  fromNodeName?: string;
  toPeerId: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  direction: 'sent' | 'received';
  createdAt: number;
}

interface PeerInfo {
  peerId: string;
  name?: string;
  connected: boolean;
  lastSeen: number;
  repos: string[];
}

// --- Helpers ---

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hours ago`;
  return `${Math.floor(diff / 86_400_000)} days ago`;
}

function truncatePeerId(peerId: string): string {
  if (peerId.length <= 16) return peerId;
  return `${peerId.slice(0, 12)}...${peerId.slice(-4)}`;
}

// --- Sub-components ---

function CopyableId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="copyable-id">
      <div className="copyable-id-label">{label}</div>
      <div className="copyable-id-row">
        <span className="mono copyable-id-value">{value}</span>
        <button className="btn btn-small btn-secondary" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// --- Main Page ---

export function AgentsPage() {
  const { selectedRepo, refreshRepos } = useRepo();
  const [peerIdInput, setPeerIdInput] = useState('');
  const [invitations, setInvitations] = useState<{ sent: Invitation[]; received: Invitation[] }>({ sent: [], received: [] });
  const [collaborators, setCollaborators] = useState<PeerInfo[]>([]);
  const [myPeerId, setMyPeerId] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConvertDialog, setShowConvertDialog] = useState(false);

  const isLocal = !selectedRepo || (selectedRepo.privacyLevel ?? 'local') === 'local';
  const isShared = selectedRepo && selectedRepo.privacyLevel === 'shared';

  // Fetch own peer ID on mount
  useEffect(() => {
    fetchInfo().then(info => setMyPeerId(info.peerId)).catch(() => {});
  }, []);

  // Poll invitations
  const loadInvitations = useCallback(async () => {
    try {
      const data = await fetchInvitations();
      setInvitations(data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadInvitations();
    const interval = setInterval(loadInvitations, 10_000);
    return () => clearInterval(interval);
  }, [loadInvitations]);

  // Poll collaborators for shared repos
  useEffect(() => {
    if (!selectedRepo || !isShared) {
      setCollaborators([]);
      return;
    }
    const load = async () => {
      try {
        const data = await fetchCollaborators(selectedRepo.owner, selectedRepo.repo);
        setCollaborators(data.collaborators ?? []);
      } catch { /* silent */ }
    };
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [selectedRepo, isShared]);

  // --- Actions ---

  async function handleConvert() {
    if (!selectedRepo) return;
    setSharing(true);
    setError(null);
    try {
      await convertToShared(selectedRepo.owner, selectedRepo.repo);
      await refreshRepos();
      setShowConvertDialog(false);
    } catch (err: any) {
      setError(err.message ?? 'Failed to convert to shared mode');
    } finally {
      setSharing(false);
    }
  }

  async function handleInvite() {
    if (!selectedRepo || !peerIdInput.trim()) return;
    setInviting(true);
    setError(null);
    try {
      await sendInvitation(selectedRepo.owner, selectedRepo.repo, peerIdInput.trim());
      setPeerIdInput('');
      await loadInvitations();
    } catch (err: any) {
      setError(err.message ?? 'Failed to send invitation');
    } finally {
      setInviting(false);
    }
  }

  async function handleAccept(invitationId: string) {
    setError(null);
    try {
      await acceptInvitation(invitationId);
      await loadInvitations();
      await refreshRepos();
    } catch (err: any) {
      setError(err.message ?? 'Failed to accept invitation');
    }
  }

  async function handleDecline(invitationId: string) {
    setError(null);
    try {
      await declineInvitation(invitationId);
      await loadInvitations();
    } catch (err: any) {
      setError(err.message ?? 'Failed to decline invitation');
    }
  }

  async function handleRevoke(invitationId: string) {
    setError(null);
    try {
      await revokeInvitation(invitationId);
      await loadInvitations();
    } catch (err: any) {
      setError(err.message ?? 'Failed to revoke invitation');
    }
  }

  // --- No repo selected ---

  if (!selectedRepo) {
    return (
      <div className="page">
        <h2 className="page-title">Collaboration</h2>
        <div className="empty-state">
          <p>Select a repository from the dropdown above to view collaboration settings.</p>
        </div>
      </div>
    );
  }

  const pendingReceived = invitations.received.filter(i => i.status === 'pending');
  const pendingSent = invitations.sent.filter(i => i.status === 'pending');
  const onlinePeers = collaborators.filter(c => c.connected);
  const offlinePeers = collaborators.filter(c => !c.connected);

  return (
    <div className="page">
      <h2 className="page-title">Collaboration</h2>
      {isShared && (
        <p className="collab-subtitle">
          DKG V9 nodes subscribed to this repository's shared space (paranet).
          These peers can query the knowledge graph, participate in reviews, and coordinate work.
        </p>
      )}

      {error && <div className="collab-error">{error}</div>}

      {/* Conversion confirmation dialog */}
      {showConvertDialog && (
        <div className="collab-dialog-overlay">
          <div className="collab-dialog">
            <h3>Convert to Shared Mode?</h3>
            <p className="collab-text">Repository: <strong className="mono">{repoKey(selectedRepo)}</strong></p>
            <p className="collab-text">This will:</p>
            <ul className="collab-list">
              <li>Generate a unique shared space ID (paranet)</li>
              <li>Subscribe to the P2P collaboration network</li>
              <li>Allow you to invite other DKG V9 nodes</li>
            </ul>
            <p className="collab-text collab-text--small">
              Your existing local data remains on this node. Only new data written after conversion will be visible to invited collaborators.
            </p>
            <p className="collab-text collab-text--xs collab-text--italic">
              Note: Workspace data in shared mode expires after 30 days unless enshrined (made permanent).
            </p>
            <div className="collab-dialog-actions">
              <button className="btn btn-secondary" onClick={() => setShowConvertDialog(false)} disabled={sharing}>Cancel</button>
              <button className="btn btn-success" onClick={handleConvert} disabled={sharing}>
                {sharing ? 'Converting...' : 'Convert to Shared'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== STATE A: Local Only Mode ===== */}
      {isLocal && (
        <div className="collab-card">
          <div className="collab-section-label collab-section-label--warning">Local Only Mode</div>
          <p className="collab-text">
            This repository is in Local Only mode. Data stays on this node and is not shared with other DKG V9 nodes.
          </p>
          <p className="collab-text">
            To collaborate with other nodes, convert to Shared mode. This will:
          </p>
          <ul className="collab-list">
            <li>Register a shared space (paranet) for this repo</li>
            <li>Allow you to invite other DKG V9 nodes</li>
            <li>Enable collaborative reviews and coordination</li>
            <li>Workspace data expires after 30 days unless enshrined (made permanent)</li>
          </ul>
          <p className="collab-text collab-text--small">
            Your existing local data will remain accessible. Only new data written after conversion will be visible to invited collaborators.
          </p>
          <button className="btn btn-success" onClick={() => setShowConvertDialog(true)}>
            Share &amp; Collaborate
          </button>
        </div>
      )}

      {/* ===== STATES B & C: Shared Mode ===== */}
      {isShared && (
        <>
          {/* Shared Space banner */}
          <div className="collab-card">
            <div className="collab-banner-header">
              <span className="collab-section-label collab-section-label--success">Shared Space</span>
              {collaborators.length > 0 ? (
                <span className="collab-peer-count">
                  {onlinePeers.length} peer{onlinePeers.length !== 1 ? 's' : ''} online
                </span>
              ) : (
                <span className="collab-peer-count">No peers connected</span>
              )}
            </div>
            <CopyableId label="Paranet ID:" value={selectedRepo.paranetId} />
            {myPeerId && <CopyableId label="Your Peer ID:" value={myPeerId} />}
          </div>

          {/* Collaborators (State C) */}
          <div className="collab-card">
            <div className="collab-section-label">Collaborators ({collaborators.length})</div>
            {collaborators.length === 0 ? (
              <p className="collab-text">No collaborators yet. Invite peers to get started.</p>
            ) : (
              <>
                {onlinePeers.map(peer => (
                  <div key={peer.peerId} className="collab-peer-row">
                    <span className="collab-peer-dot collab-peer-dot--online" />
                    <div className="collab-peer-info">
                      <div className="collab-peer-name">{peer.name ?? truncatePeerId(peer.peerId)}</div>
                      <div className="mono collab-peer-id">{truncatePeerId(peer.peerId)}</div>
                    </div>
                    <span className="collab-peer-status collab-peer-status--online">Online</span>
                    <span className="collab-peer-lastseen">Last: {timeAgo(peer.lastSeen)}</span>
                  </div>
                ))}
                {offlinePeers.map(peer => (
                  <div key={peer.peerId} className="collab-peer-row collab-peer-row--offline">
                    <span className="collab-peer-dot collab-peer-dot--offline" />
                    <div className="collab-peer-info">
                      <div className="collab-peer-name">{peer.name ?? truncatePeerId(peer.peerId)}</div>
                      <div className="mono collab-peer-id">{truncatePeerId(peer.peerId)}</div>
                    </div>
                    <span className="collab-peer-status collab-peer-status--offline">Offline</span>
                    <span className="collab-peer-lastseen">Last: {timeAgo(peer.lastSeen)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Invite a Peer */}
          <div className="collab-card">
            <div className="collab-section-label">Invite a Peer</div>
            <p className="collab-text collab-text--small">
              Enter a peer's DKG V9 node ID to invite them to collaborate on this repository.
            </p>
            <div className="collab-invite-row">
              <input
                type="text"
                className="collab-invite-input"
                placeholder="12D3KooW..."
                value={peerIdInput}
                onChange={e => setPeerIdInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleInvite()}
              />
              <button className="btn" onClick={handleInvite} disabled={inviting || !peerIdInput.trim()}>
                {inviting ? 'Sending...' : 'Invite'}
              </button>
            </div>
            <p className="collab-text collab-text--xs">
              -- OR -- Share your Paranet ID with collaborators so they can join manually from their own node.
            </p>
          </div>

          {/* Sent Invitations */}
          {invitations.sent.length > 0 && (
            <div className="collab-card">
              <div className="collab-section-label">Sent Invitations ({pendingSent.length} pending)</div>
              {invitations.sent.map(inv => (
                <div key={inv.invitationId} className="collab-inv-row">
                  <span className="mono" style={{ fontSize: '0.9em' }}>{truncatePeerId(inv.toPeerId)}</span>
                  <div className="collab-inv-meta">
                    <span className={`collab-inv-badge collab-inv-badge--${inv.status}`}>{inv.status}</span>
                    <span className="collab-inv-time">Sent {timeAgo(inv.createdAt)}</span>
                    {inv.status === 'pending' && (
                      <button className="btn btn-small btn-secondary btn-muted" onClick={() => handleRevoke(inv.invitationId)}>Revoke</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Pending Invitations (Incoming) -- shown regardless of repo mode */}
      <div className="collab-card">
        <div className="collab-section-label">
          Pending Invitations (Incoming){pendingReceived.length > 0 ? ` (${pendingReceived.length})` : ''}
        </div>
        {pendingReceived.length === 0 ? (
          <p className="collab-text">No incoming invitations.</p>
        ) : (
          pendingReceived.map(inv => (
            <div key={inv.invitationId} className="collab-incoming">
              <div className="collab-incoming-from">
                <span className="collab-incoming-from-name">{inv.fromNodeName ?? truncatePeerId(inv.fromPeerId)}</span>
                {inv.fromNodeName && (
                  <span className="mono collab-incoming-from-id">({truncatePeerId(inv.fromPeerId)})</span>
                )}
                <span className="collab-incoming-text"> invited you to collaborate on </span>
                <strong>{inv.repoKey}</strong>
              </div>
              <div className="mono collab-incoming-paranet">Paranet: {inv.paranetId}</div>
              <div className="collab-incoming-time">Received: {timeAgo(inv.createdAt)}</div>
              <div className="collab-incoming-actions">
                <button className="btn btn-success" onClick={() => handleAccept(inv.invitationId)}>Accept</button>
                <button className="btn btn-secondary btn-muted" onClick={() => handleDecline(inv.invitationId)}>Decline</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Activity section */}
      {isShared && (
        <div className="collab-card">
          <div className="collab-section-label">Activity</div>
          {collaborators.length === 0 ? (
            <p className="collab-text">No activity yet. Invite peers to get started.</p>
          ) : (
            <p className="collab-text">Activity log coming soon.</p>
          )}
        </div>
      )}
    </div>
  );
}
