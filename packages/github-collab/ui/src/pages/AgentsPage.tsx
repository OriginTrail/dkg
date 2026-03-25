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
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: '0.85em', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mono" style={{ background: 'var(--bg)', padding: '4px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
        <button onClick={handleCopy} style={{ whiteSpace: 'nowrap', minWidth: 60 }}>
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
        <p style={{ color: 'var(--text-muted)', margin: '-8px 0 16px' }}>
          DKG V9 nodes subscribed to this repository's shared space (paranet).
          These peers can query the knowledge graph, participate in reviews, and coordinate work.
        </p>
      )}

      {error && (
        <div style={{ padding: '8px 12px', marginBottom: 16, background: 'var(--bg-danger, #2d1b1b)', border: '1px solid var(--danger, #e53e3e)', borderRadius: 'var(--radius)', color: 'var(--danger, #e53e3e)' }}>
          {error}
        </div>
      )}

      {/* Conversion confirmation dialog */}
      {showConvertDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-card, #1a1a2e)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 24, maxWidth: 480, width: '90%' }}>
            <h3 style={{ margin: '0 0 12px' }}>Convert to Shared Mode?</h3>
            <p style={{ color: 'var(--text-muted)' }}>Repository: <strong className="mono">{repoKey(selectedRepo)}</strong></p>
            <p style={{ color: 'var(--text-muted)' }}>This will:</p>
            <ul style={{ color: 'var(--text-muted)', paddingLeft: 20, margin: '8px 0' }}>
              <li>Generate a unique shared space ID (paranet)</li>
              <li>Subscribe to the P2P collaboration network</li>
              <li>Allow you to invite other DKG V9 nodes</li>
            </ul>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9em' }}>
              Your existing local data remains on this node. Only new data written after conversion will be visible to invited collaborators.
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85em', fontStyle: 'italic' }}>
              Note: Workspace data in shared mode expires after 30 days unless enshrined (made permanent).
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setShowConvertDialog(false)} disabled={sharing}>Cancel</button>
              <button onClick={handleConvert} disabled={sharing} style={{ background: 'var(--green, #4ade80)', color: '#000', fontWeight: 600 }}>
                {sharing ? 'Converting...' : 'Convert to Shared'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== STATE A: Local Only Mode ===== */}
      {isLocal && (
        <div style={{ padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <div style={{ textTransform: 'uppercase', fontSize: '0.75em', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--warning, #d69e2e)', marginBottom: 12 }}>
            Local Only Mode
          </div>
          <p style={{ color: 'var(--text-muted)', margin: '0 0 8px' }}>
            This repository is in Local Only mode. Data stays on this node and is not shared with other DKG V9 nodes.
          </p>
          <p style={{ color: 'var(--text-muted)', margin: '0 0 8px' }}>
            To collaborate with other nodes, convert to Shared mode. This will:
          </p>
          <ul style={{ color: 'var(--text-muted)', paddingLeft: 20, margin: '0 0 12px' }}>
            <li>Register a shared space (paranet) for this repo</li>
            <li>Allow you to invite other DKG V9 nodes</li>
            <li>Enable collaborative reviews and coordination</li>
            <li>Workspace data expires after 30 days unless enshrined (made permanent)</li>
          </ul>
          <p style={{ color: 'var(--text-muted)', margin: '0 0 16px', fontSize: '0.9em' }}>
            Your existing local data will remain accessible. Only new data written after conversion will be visible to invited collaborators.
          </p>
          <button onClick={() => setShowConvertDialog(true)} style={{ background: 'var(--green, #4ade80)', color: '#000', fontWeight: 600 }}>
            Share & Collaborate
          </button>
        </div>
      )}

      {/* ===== STATES B & C: Shared Mode ===== */}
      {isShared && (
        <>
          {/* Shared Space banner */}
          <div style={{ padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ textTransform: 'uppercase', fontSize: '0.75em', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--green, #4ade80)' }}>
                Shared Space
              </span>
              {collaborators.length > 0 ? (
                <span style={{ fontSize: '0.85em', color: 'var(--text-muted)' }}>
                  {onlinePeers.length} peer{onlinePeers.length !== 1 ? 's' : ''} online
                </span>
              ) : (
                <span style={{ fontSize: '0.85em', color: 'var(--text-muted)' }}>No peers connected</span>
              )}
            </div>
            <CopyableId label="Paranet ID:" value={selectedRepo.paranetId} />
            {myPeerId && <CopyableId label="Your Peer ID:" value={myPeerId} />}
          </div>

          {/* Collaborators (State C) */}
          <div style={{ padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 20 }}>
            <div style={{ textTransform: 'uppercase', fontSize: '0.75em', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 12 }}>
              Collaborators ({collaborators.length})
            </div>
            {collaborators.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', margin: 0 }}>No collaborators yet. Invite peers to get started.</p>
            ) : (
              <>
                {onlinePeers.map(peer => (
                  <div key={peer.peerId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green, #4ade80)', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{peer.name ?? truncatePeerId(peer.peerId)}</div>
                      <div className="mono" style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>{truncatePeerId(peer.peerId)}</div>
                    </div>
                    <span style={{ fontSize: '0.8em', color: 'var(--green, #4ade80)' }}>Online</span>
                    <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Last: {timeAgo(peer.lastSeen)}</span>
                  </div>
                ))}
                {offlinePeers.map(peer => (
                  <div key={peer.peerId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', opacity: 0.6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1px solid var(--text-muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{peer.name ?? truncatePeerId(peer.peerId)}</div>
                      <div className="mono" style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>{truncatePeerId(peer.peerId)}</div>
                    </div>
                    <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Offline</span>
                    <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Last: {timeAgo(peer.lastSeen)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Invite a Peer */}
          <div style={{ padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 20 }}>
            <div style={{ textTransform: 'uppercase', fontSize: '0.75em', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
              Invite a Peer
            </div>
            <p style={{ color: 'var(--text-muted)', margin: '0 0 10px', fontSize: '0.9em' }}>
              Enter a peer's DKG V9 node ID to invite them to collaborate on this repository.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                placeholder="12D3KooW..."
                value={peerIdInput}
                onChange={e => setPeerIdInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleInvite()}
                style={{ flex: 1, padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)' }}
              />
              <button onClick={handleInvite} disabled={inviting || !peerIdInput.trim()}>
                {inviting ? 'Sending...' : 'Invite'}
              </button>
            </div>
            <p style={{ color: 'var(--text-muted)', margin: '10px 0 0', fontSize: '0.85em' }}>
              -- OR -- Share your Paranet ID with collaborators so they can join manually from their own node.
            </p>
          </div>

          {/* Sent Invitations */}
          {invitations.sent.length > 0 && (
            <div style={{ padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 20 }}>
              <div style={{ textTransform: 'uppercase', fontSize: '0.75em', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Sent Invitations ({pendingSent.length} pending)
              </div>
              {invitations.sent.map(inv => (
                <div key={inv.invitationId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="mono" style={{ fontSize: '0.9em' }}>{truncatePeerId(inv.toPeerId)}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 'var(--radius)',
                      fontSize: '0.8em',
                      background: inv.status === 'accepted' ? 'var(--green, #4ade80)' : inv.status === 'declined' ? 'var(--danger, #e53e3e)' : 'var(--warning, #d69e2e)',
                      color: '#000',
                    }}>
                      {inv.status}
                    </span>
                    <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Sent {timeAgo(inv.createdAt)}</span>
                    {inv.status === 'pending' && (
                      <button onClick={() => handleRevoke(inv.invitationId)} style={{ fontSize: '0.8em', opacity: 0.7 }}>Revoke</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Pending Invitations (Incoming) — shown regardless of repo mode */}
      <div style={{ padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 20, marginTop: isLocal ? 20 : 0 }}>
        <div style={{ textTransform: 'uppercase', fontSize: '0.75em', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
          Pending Invitations (Incoming){pendingReceived.length > 0 ? ` (${pendingReceived.length})` : ''}
        </div>
        {pendingReceived.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>No incoming invitations.</p>
        ) : (
          pendingReceived.map(inv => (
            <div key={inv.invitationId} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontWeight: 500 }}>{inv.fromNodeName ?? truncatePeerId(inv.fromPeerId)}</span>
                {inv.fromNodeName && (
                  <span className="mono" style={{ fontSize: '0.8em', color: 'var(--text-muted)', marginLeft: 6 }}>({truncatePeerId(inv.fromPeerId)})</span>
                )}
                <span style={{ color: 'var(--text-muted)' }}> invited you to collaborate on </span>
                <strong>{inv.repoKey}</strong>
              </div>
              <div className="mono" style={{ fontSize: '0.8em', color: 'var(--text-muted)', marginBottom: 4 }}>
                Paranet: {inv.paranetId}
              </div>
              <div style={{ fontSize: '0.8em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Received: {timeAgo(inv.createdAt)}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => handleAccept(inv.invitationId)} style={{ background: 'var(--green, #4ade80)', color: '#000', fontWeight: 600 }}>Accept</button>
                <button onClick={() => handleDecline(inv.invitationId)} style={{ opacity: 0.7 }}>Decline</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Activity section */}
      {isShared && (
        <div style={{ padding: '16px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <div style={{ textTransform: 'uppercase', fontSize: '0.75em', fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
            Activity
          </div>
          {collaborators.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>No activity yet. Invite peers to get started.</p>
          ) : (
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>Activity log coming soon.</p>
          )}
        </div>
      )}
    </div>
  );
}
