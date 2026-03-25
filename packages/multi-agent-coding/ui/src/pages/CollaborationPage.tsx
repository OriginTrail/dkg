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
  fetchSessions,
  fetchClaims,
  fetchDecisions,
  fetchActivity,
  fetchSyncStatus,
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
  const [migrationSyncJobId, setMigrationSyncJobId] = useState<string | null>(null);
  const [migrationProgress, setMigrationProgress] = useState<string | null>(null);

  // Activity state
  const [activeSessions, setActiveSessions] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [activityFeed, setActivityFeed] = useState<any[]>([]);

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

  // Poll agent activity for shared repos
  useEffect(() => {
    if (!selectedRepo || !isShared) {
      setActiveSessions([]);
      setClaims([]);
      setDecisions([]);
      setActivityFeed([]);
      return;
    }
    const rk = `${selectedRepo.owner}/${selectedRepo.repo}`;
    const loadActivity = async () => {
      try {
        const [sessData, claimData, decData, actData] = await Promise.all([
          fetchSessions('active'),
          fetchClaims(rk),
          fetchDecisions(rk),
          fetchActivity(rk, 50),
        ]);
        setActiveSessions(sessData.sessions ?? []);
        setClaims(claimData.claims ?? []);
        setDecisions(decData.decisions ?? []);
        setActivityFeed(actData.activities ?? []);
      } catch { /* silent */ }
    };
    loadActivity();
    const interval = setInterval(loadActivity, 10_000);
    return () => clearInterval(interval);
  }, [selectedRepo, isShared]);

  // --- Actions ---

  async function handleConvert() {
    if (!selectedRepo) return;
    setSharing(true);
    setError(null);
    setMigrationProgress('Creating shared space...');
    try {
      const result = await convertToShared(selectedRepo.owner, selectedRepo.repo);
      if (result.syncJobId) {
        setMigrationSyncJobId(result.syncJobId);
        setMigrationProgress('Migrating data to shared space...');
      } else {
        setShowConvertDialog(false);
      }
      await refreshRepos();
    } catch (err: any) {
      setError(err.message ?? 'Failed to convert to shared mode');
      setMigrationProgress(null);
    } finally {
      setSharing(false);
    }
  }

  // Poll migration sync progress
  useEffect(() => {
    if (!migrationSyncJobId) return;
    const interval = setInterval(async () => {
      try {
        const job = await fetchSyncStatus(migrationSyncJobId);
        if (job.status === 'completed') {
          setMigrationProgress(null);
          setMigrationSyncJobId(null);
          setShowConvertDialog(false);
        } else if (job.status === 'failed') {
          setMigrationProgress('Sync incomplete. You can retry from the Settings page.');
          setMigrationSyncJobId(null);
        } else {
          // Show progress phases
          const phases = Object.entries(job.progress ?? {}).map(
            ([phase, p]: [string, any]) => `${phase}: ${p.synced}/${p.total}`,
          );
          setMigrationProgress(`Syncing from GitHub... ${phases.join(', ')}`);
        }
      } catch { /* silent */ }
    }, 2_000);
    return () => clearInterval(interval);
  }, [migrationSyncJobId]);

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
            {migrationProgress && (
              <p className="collab-text collab-text--small" style={{ color: 'var(--green, #4ade80)' }}>
                {migrationProgress}
              </p>
            )}
            <div className="collab-dialog-actions">
              <button className="btn btn-secondary" onClick={() => { setShowConvertDialog(false); setMigrationProgress(null); }} disabled={sharing || !!migrationSyncJobId}>Cancel</button>
              <button className="btn btn-success" onClick={handleConvert} disabled={sharing || !!migrationSyncJobId}>
                {sharing ? 'Converting...' : migrationSyncJobId ? 'Syncing...' : 'Convert & Sync'}
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

      {/* ===== Agent Activity Section ===== */}
      {isShared && (
        <>
          {/* Active Sessions */}
          <div className="collab-card">
            <div className="collab-section-label">Active Sessions ({activeSessions.length})</div>
            {activeSessions.length === 0 ? (
              <p className="collab-text">No active agent sessions.</p>
            ) : (
              activeSessions.map((s: any) => (
                <div key={s.sessionId} className="collab-peer-row">
                  <span className="collab-peer-dot collab-peer-dot--online" />
                  <div className="collab-peer-info">
                    <div className="collab-peer-name">{s.agentName}</div>
                    {s.goal && <div className="collab-text collab-text--xs">{s.goal}</div>}
                    {s.modifiedFiles?.length > 0 && (
                      <div className="mono collab-text collab-text--xs">
                        Files: {s.modifiedFiles.slice(0, 3).join(', ')}{s.modifiedFiles.length > 3 ? ` (+${s.modifiedFiles.length - 3} more)` : ''}
                      </div>
                    )}
                  </div>
                  <span className="collab-peer-status collab-peer-status--online">
                    Active {timeAgo(s.startedAt)}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* File Claims */}
          {claims.length > 0 && (
            <div className="collab-card">
              <div className="collab-section-label">File Claims ({claims.length})</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border, #333)', textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px' }}>File</th>
                    <th style={{ padding: '4px 8px' }}>Agent</th>
                    <th style={{ padding: '4px 8px' }}>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c: any) => (
                    <tr key={c.claimId} style={{ borderBottom: '1px solid var(--border, #222)' }}>
                      <td className="mono" style={{ padding: '4px 8px', fontSize: '0.85em' }}>{c.file}</td>
                      <td style={{ padding: '4px 8px' }}>{c.agent}</td>
                      <td style={{ padding: '4px 8px' }}>{c.since ? timeAgo(new Date(c.since).getTime()) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Decisions */}
          {decisions.length > 0 && (
            <div className="collab-card">
              <div className="collab-section-label">Recent Decisions ({decisions.length})</div>
              {decisions.slice(0, 5).map((d: any) => (
                <div key={d.decisionId} style={{ marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid var(--border, #222)' }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>{d.summary}</div>
                  <div className="collab-text collab-text--xs">{d.rationale}</div>
                  <div className="collab-text collab-text--xs" style={{ marginTop: '4px', opacity: 0.6 }}>
                    by {d.agentName} {d.createdAt ? timeAgo(d.createdAt) : ''}
                    {d.affectedFiles?.length > 0 && ` | Affects: ${d.affectedFiles.join(', ')}`}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Activity Timeline */}
          <div className="collab-card">
            <div className="collab-section-label">Timeline</div>
            {activityFeed.length === 0 ? (
              <p className="collab-text">No activity recorded yet.</p>
            ) : (
              activityFeed.slice(0, 20).map((a: any, i: number) => (
                <div key={`${a.entityId ?? i}-${a.timestamp}`} style={{ display: 'flex', gap: '12px', padding: '4px 0', fontSize: '0.9em', borderBottom: '1px solid var(--border, #1a1a1a)' }}>
                  <span style={{ minWidth: '60px', opacity: 0.5, fontSize: '0.85em' }}>{timeAgo(a.timestamp)}</span>
                  <span style={{ minWidth: '120px' }}>{a.agent}</span>
                  <span>{a.detail}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
