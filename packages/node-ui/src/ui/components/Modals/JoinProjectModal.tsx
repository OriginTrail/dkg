import React, { useState, useEffect } from 'react';
import {
  subscribeToContextGraph, fetchContextGraphs,
  signJoinRequest, submitJoinRequest, fetchCurrentAgent, fetchCatchupStatus,
  connectToPeerWithTimeout,
} from '../../api.js';
import { useProjectsStore } from '../../stores/projects.js';
import { useTabsStore } from '../../stores/tabs.js';

interface JoinProjectModalProps {
  open: boolean;
  onClose: () => void;
  initialContextGraphId?: string;
}

function parseInviteCode(raw: string): { cgId: string; multiaddr: string | null } {
  const normalized = raw.trim().replace(/\\n/g, '\n');
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const cgId = lines[0] ?? '';
  const multilineMultiaddr = lines.slice(1).join('').replace(/\s+/g, '');
  const inlineMultiaddrMatch = normalized.match(/(?:^|\s)(\/(?:ip4|ip6|dns|dns4|dns6)\/\S+)/);
  const inlineMultiaddr = inlineMultiaddrMatch?.[1]?.replace(/\s+/g, '') ?? null;
  const multiaddr = multilineMultiaddr.startsWith('/') ? multilineMultiaddr : inlineMultiaddr;
  return { cgId, multiaddr };
}

function validateInvite(cgId: string, multiaddr: string | null): string | null {
  if (!cgId) return 'Missing project ID';
  if (!multiaddr) return null;
  if (!multiaddr.startsWith('/')) return 'Invalid curator multiaddr';
  if (!multiaddr.includes('/p2p/')) return 'Curator multiaddr is missing peer ID';
  return null;
}

async function pollCatchupStatus(cgId: string, maxAttempts = 10, intervalMs = 1500): Promise<{ status: string; error?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const result = await fetchCatchupStatus(cgId);
      if (result.status === 'done' || result.status === 'denied' || result.status === 'failed') {
        return { status: result.status, error: result.error };
      }
    } catch {
      // Status endpoint may not be ready yet
    }
  }
  return { status: 'timeout' };
}

export function JoinProjectModal({ open, onClose, initialContextGraphId }: JoinProjectModalProps) {
  const [inviteCode, setInviteCode] = useState(initialContextGraphId ?? '');
  const [joining, setJoining] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [sendingRequest, setSendingRequest] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const { setContextGraphs, setActiveProject } = useProjectsStore();
  const { openTab } = useTabsStore();

  useEffect(() => {
    if (initialContextGraphId) setInviteCode(initialContextGraphId);
  }, [initialContextGraphId]);

  useEffect(() => {
    if (!open) {
      setInviteCode(initialContextGraphId ?? '');
      setError(null);
      setSuccess(false);
      setRequestSent(false);
      setAccessDenied(false);
      setProgress('');
    }
  }, [open, initialContextGraphId]);

  if (!open) return null;

  const handleJoin = async () => {
    const { cgId, multiaddr } = parseInviteCode(inviteCode);
    const inviteError = validateInvite(cgId, multiaddr);
    if (inviteError) {
      setError(inviteError);
      return;
    }

    setJoining(true);
    setError(null);
    setSuccess(false);
    setRequestSent(false);
    setAccessDenied(false);

    try {
      if (multiaddr) {
        setProgress('Connecting to curator node…');
        try {
          await connectToPeerWithTimeout(multiaddr);
          await new Promise(r => setTimeout(r, 1000));
        } catch {
          // Non-fatal — subscribe/catch-up may still work via existing peers/relays.
        }
      }

      setProgress('Subscribing to project…');
      const subResult = await subscribeToContextGraph(cgId);

      setProgress('Syncing knowledge from peers…');

      // Poll catchup status to detect denials
      const catchup = await pollCatchupStatus(cgId);

      if (catchup.status === 'denied') {
        setAccessDenied(true);
        setProgress('');
        return;
      }

      if (catchup.status === 'failed') {
        setError(catchup.error || 'Sync failed');
        setProgress('');
        return;
      }

      if (catchup.status === 'timeout') {
        setError('Project subscription succeeded, but syncing is still in progress. Please wait a few seconds and try again.');
        setProgress('');
        return;
      }

      setProgress('Refreshing project list…');
      const { contextGraphs: freshList } = await fetchContextGraphs();
      setContextGraphs(freshList ?? []);

      const joined = freshList?.find((cg: any) => cg.id === cgId);
      if (joined) {
        setActiveProject(joined.id);
        openTab({ id: `project:${joined.id}`, label: joined.name || joined.id, closable: true });
      }

      setSuccess(true);
      setProgress('');
      setTimeout(() => onClose(), 1500);
    } catch (err: any) {
      const msg = err?.message || 'Failed to join project';
      if (msg.includes('already subscribed') || msg.includes('409')) {
        setError('You are already a member of this project.');
      } else if (msg.includes('not on the allowlist') || msg.includes('403') || msg.includes('denied')) {
        setAccessDenied(true);
      } else {
        setError(msg);
      }
      setProgress('');
    } finally {
      setJoining(false);
    }
  };

  const handleSendRequest = async () => {
    const { cgId, multiaddr } = parseInviteCode(inviteCode);
    const inviteError = validateInvite(cgId, multiaddr);
    if (inviteError) {
      setError(inviteError);
      return;
    }

    setSendingRequest(true);
    setError(null);

    try {
      if (multiaddr) {
        try {
          await connectToPeerWithTimeout(multiaddr);
          await new Promise(r => setTimeout(r, 500));
        } catch {
          // Non-fatal — signed join requests can still be delivered via existing peers.
        }
      }

      const signed = await signJoinRequest(cgId);

      let agentName: string | undefined;
      try {
        const identity = await fetchCurrentAgent();
        agentName = identity.name;
      } catch {
        // Non-fatal
      }

      await submitJoinRequest(cgId, { ...signed, agentName });
      setRequestSent(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to send join request');
    } finally {
      setSendingRequest(false);
    }
  };

  return (
    <div className="v10-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v10-modal-box">
        <div className="v10-modal-header">
          <div className="v10-modal-title">Join a Project</div>
          <div className="v10-modal-subtitle">
            Enter the project ID shared by a collaborator. Your node will subscribe and sync existing knowledge.
          </div>
        </div>

        <div className="v10-modal-body">
          {error && <div className="v10-modal-error">{error}</div>}

          {success && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.25)',
              color: 'var(--accent-green)',
            }}>
              Successfully joined! Syncing knowledge from peers…
            </div>
          )}

          {requestSent && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.25)',
              color: 'var(--accent-primary, #3b82f6)',
            }}>
              Join request sent! The project curator will review and approve your request.
              You'll be able to join once approved.
            </div>
          )}

          {accessDenied && !requestSent && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)',
              color: 'var(--accent-warning, #f59e0b)',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Access Restricted</div>
              This is a curated project and your agent is not on the allowlist.
              You can send a <strong>signed join request</strong> to the curator for approval.
              <div style={{ marginTop: 8 }}>
                <button
                  className="v10-modal-btn primary"
                  onClick={handleSendRequest}
                  disabled={sendingRequest}
                  style={{ fontSize: 11 }}
                >
                  {sendingRequest ? 'Signing & sending…' : 'Send Join Request'}
                </button>
              </div>
            </div>
          )}

          <div className="v10-form-group">
            <label className="v10-form-label">Invite Code</label>
            <textarea
              className="v10-form-textarea"
              placeholder={"Paste the invite code from the project curator.\n\ne.g.\ncg:my-project-abc123\n/ip4/1.2.3.4/tcp/10001/p2p/12D3KooW..."}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoFocus
              rows={3}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
              The invite code contains a project ID and optionally the curator's node address.
            </div>
          </div>

          <div className="v10-modal-tip">
            <div className="v10-modal-tip-title">How it works</div>
            Your node will connect to the curator's node (if an address is included), subscribe to the project,
            and start syncing knowledge assets. For curated projects, the curator must approve your join request first.
            All requests are signed with your agent's wallet key to verify your identity.
          </div>
        </div>

        <div className="v10-modal-footer">
          <button className="v10-modal-btn" onClick={onClose}>Cancel</button>
          <button
            className="v10-modal-btn primary"
            onClick={handleJoin}
            disabled={!inviteCode.trim() || joining || success || requestSent}
          >
            {joining ? progress || 'Joining…' : success ? '✓ Joined' : 'Join Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
