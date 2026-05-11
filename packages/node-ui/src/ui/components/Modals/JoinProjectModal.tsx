import React, { useState, useEffect } from 'react';
import {
  subscribeToContextGraph, fetchContextGraphs,
  signJoinRequest, submitJoinRequest, fetchCurrentAgent, fetchCatchupStatus,
  connectToPeerWithTimeout, connectToPeerIdWithTimeout,
} from '../../api.js';
import { useProjectsStore } from '../../stores/projects.js';
import { useTabsStore } from '../../stores/tabs.js';
import { WireWorkspacePanel } from '../Workspace/WireWorkspacePanel.js';

interface JoinProjectModalProps {
  open: boolean;
  onClose: () => void;
  initialContextGraphId?: string;
}

export interface ParsedInvite {
  cgId: string;
  /**
   * V10 invite form: a bare libp2p peer id on the second line. The joiner's
   * daemon resolves it via Kademlia DHT (`peerRouting.findPeer`) so the invite
   * stays valid across the curator's relay rotations / IP changes.
   */
  curatorPeerId: string | null;
  /**
   * Legacy invite form: a `/ip4/.../p2p/.../p2p-circuit/p2p/<peerId>` style
   * multiaddr embedded directly in the invite. Still accepted for one release;
   * a console.warn deprecation notice fires when the joiner falls back to it.
   */
  legacyMultiaddr: string | null;
  /**
   * True when the invite carried content beyond the cgId line that neither
   * parser (peer id / multiaddr) recognized. `validateInvite` uses this to
   * reject silent-fallback behaviour where a typo'd peer id like
   * `12D3KooBAD` would otherwise be discarded and the user dropped into the
   * bare-cgId flow without an immediate input error. Codex review on
   * PR #431 flagged this as Issue (yellow).
   */
  hasUnparsedExtra: boolean;
}

const PEER_ID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|12D3Koo[1-9A-HJ-NP-Za-km-z]{45,53})$/;

export function parseInviteCode(raw: string): ParsedInvite {
  const normalized = raw.trim().replace(/\\n/g, '\n');
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const remainder = lines.slice(1).join(' ').trim();

  // Legacy: any `/ip4|ip6|dns…/.../p2p/<id>` token anywhere in the body.
  // Codex review on PR #431 (round 2) flagged that the old alternation
  // dropped `dnsaddr`, so a legacy invite of the form
  // `my-project /dnsaddr/example.com/p2p/...` had its multiaddr ignored
  // and the whole line collapsed into the cgId. Keep this synchronised
  // with `isMultiaddrRemotelyDialable` in ShareProjectModal.tsx.
  const inlineMultiaddrMatch = normalized.match(/(?:^|\s)(\/(?:ip4|ip6|dns|dns4|dns6|dnsaddr)\/\S+)/);
  const inlineMultiaddr = inlineMultiaddrMatch?.[1]?.replace(/\s+/g, '') ?? null;
  const multilineMultiaddr = remainder.replace(/\s+/g, '');
  const legacyMultiaddr = multilineMultiaddr.startsWith('/')
    ? multilineMultiaddr
    : inlineMultiaddr;

  // V10: a bare peer id on the second line (or anywhere after the cgId line).
  // We accept libp2p ed25519 (`12D3Koo…`) and legacy multihash (`Qm…`) shapes.
  let curatorPeerId: string | null = null;
  if (!legacyMultiaddr) {
    for (const candidate of [remainder, ...lines.slice(1)]) {
      const trimmed = candidate.trim();
      if (PEER_ID_RE.test(trimmed)) {
        curatorPeerId = trimmed;
        break;
      }
    }
  }

  // CG id: strip the inline multiaddr (if it appeared glued onto the same
  // line — a quirk of the legacy single-line invite) AND the V9 `@`
  // separator that sometimes joined them. Codex review on PR #431 (round
  // 2) flagged that the old code only stripped the multiaddr token, so
  // `my-project @ /ip4/...` parsed cgId as `"my-project @"`, which would
  // then be silently subscribed to as a non-existent CG.
  let cgId = firstLine;
  if (inlineMultiaddr && cgId.includes(inlineMultiaddr)) {
    cgId = cgId.replace(inlineMultiaddr, '');
  }
  cgId = cgId.replace(/\s*@\s*$/, '').trim();

  // Detect content past the cgId line that neither parser claimed. The
  // remainder lines combined yield non-empty text, but no peer-id and no
  // multiaddr was extracted from it. This is almost certainly a typo'd
  // invite that we should reject loudly rather than silently truncating.
  const hadExtraContent = lines.length > 1 || remainder.length > 0;
  const hasUnparsedExtra =
    hadExtraContent && curatorPeerId === null && legacyMultiaddr === null;

  return { cgId, curatorPeerId, legacyMultiaddr, hasUnparsedExtra };
}

export function validateInvite(invite: ParsedInvite): string | null {
  if (!invite.cgId) return 'Missing project ID';
  if (invite.hasUnparsedExtra) {
    return 'Invite contains a second line that is not a valid peer ID (12D3Koo…) or multiaddr (/ip4/…). Check for typos.';
  }
  if (invite.legacyMultiaddr) {
    if (!invite.legacyMultiaddr.startsWith('/')) return 'Invalid curator multiaddr';
    if (!invite.legacyMultiaddr.includes('/p2p/')) return 'Curator multiaddr is missing peer ID';
  }
  return null;
}

// Catchup iterates connected peers with a ~30s per-peer sync timeout. Even
// with parallel per-peer sync on the backend, the slowest peer gates the
// whole job, so we need a generous total wait to reliably observe denials
// for curated projects before giving up. Timeout path is deliberately not
// treated as success by the caller. (HEAD tier-4: raised from 10×1.5s to
// 60×1.5s so denials on slow curators don't get misreported as transport
// errors in the UI.)
async function pollCatchupStatus(
  cgId: string,
  maxAttempts = 60,
  intervalMs = 1500,
  onProgress?: (attempt: number, total: number) => void,
): Promise<{ status: string; error?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    onProgress?.(i + 1, maxAttempts);
    try {
      const result = await fetchCatchupStatus(cgId);
      if (
        result.status === 'done'
        || result.status === 'denied'
        || result.status === 'failed'
        || result.status === 'unreachable'
      ) {
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
  // Set when the catchup poll exits with `timeout` — neither success
  // nor a confirmed ACL denial. Surfaces a softer "if this is curated,
  // here's how to request access" affordance alongside the retry hint,
  // without misclassifying slow-public CGs as denied. Closes the
  // tier-4c G3 edge case where a CG's local-side gate
  // (`canUseSharedMemoryForContextGraph`) refuses peer responses
  // before the catchup runner can ever observe a `denied` from the
  // network — the user otherwise loses all access to the join-request
  // flow on a real curated project.
  const [timedOut, setTimedOut] = useState(false);
  // V10 `unreachable` status: catchup ran to completion, but no peer
  // could deliver the CG content — curator offline, no node holds the
  // data, or transport failures across the whole peer set. Distinct
  // from `accessDenied` (responder explicitly refused) so we can render
  // targeted copy without misleading public-CG users into thinking
  // they were rejected. The dedicated CTA leads to the same signed
  // join request flow as the curated-denied case.
  const [unreachable, setUnreachable] = useState(false);
  // Phase 8: after subscribe + catchup completes we transition into a
  // wire-workspace step so the joiner can populate a local Cursor
  // workspace from the project's manifest. `wiredCgId` flips the modal
  // into the WireWorkspacePanel; the operator can also click Skip if
  // they only want to subscribe (e.g. running a passive observer node).
  const [wiredCgId, setWiredCgId] = useState<string | null>(null);
  const [wiredProjectName, setWiredProjectName] = useState<string>('');

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
      setTimedOut(false);
      setUnreachable(false);
      setProgress('');
    }
  }, [open, initialContextGraphId]);

  if (!open) return null;

  const handleJoin = async () => {
    const invite = parseInviteCode(inviteCode);
    const inviteError = validateInvite(invite);
    if (inviteError) {
      setError(inviteError);
      return;
    }
    const { cgId, curatorPeerId, legacyMultiaddr } = invite;

    setJoining(true);
    setError(null);
    setSuccess(false);
    setRequestSent(false);
    setAccessDenied(false);
    setTimedOut(false);
    setUnreachable(false);

    try {
      if (curatorPeerId) {
        setProgress('Looking up curator on DHT…');
        try {
          await connectToPeerIdWithTimeout(curatorPeerId);
          await new Promise(r => setTimeout(r, 1000));
        } catch {
          // Non-fatal — subscribe/catch-up may still work via existing peers/relays.
        }
      } else if (legacyMultiaddr) {
        // Legacy multiaddr-in-invite: keep working for one release while
        // collaborators rotate to V10 peer-id invites. The DHT path is
        // strictly better — multiaddr invites silently break whenever the
        // chosen relay rotates. Surface a console warning so embedders /
        // bot integrators see the deprecation.
        console.warn(
          '[DKG] This invite uses a legacy multiaddr (deprecated). Ask the curator to regenerate using the current Share Project modal — V10 invites carry a peer id and resolve via DHT, so they survive relay rotations.',
        );
        setProgress('Connecting to curator node…');
        try {
          await connectToPeerWithTimeout(legacyMultiaddr);
          await new Promise(r => setTimeout(r, 1000));
        } catch {
          // Non-fatal — subscribe/catch-up may still work via existing peers/relays.
        }
      }

      setProgress('Subscribing to project…');
      const subResult = await subscribeToContextGraph(cgId);

      setProgress('Syncing knowledge from peers…');

      // Poll catchup status to detect denials — the background job may take
      // up to ~90s on curated projects because each peer's sync request is
      // subject to the remote-side ACL timeout before we can conclude the
      // CG is denied. Don't treat the poll timeout as success.
      const catchup = await pollCatchupStatus(cgId, 60, 1500, (attempt, total) => {
        setProgress(`Syncing knowledge from peers… (${attempt}/${total})`);
      });

      if (catchup.status === 'denied') {
        setAccessDenied(true);
        setProgress('');
        return;
      }

      if (catchup.status === 'unreachable') {
        // Daemon reached a clean terminal state but no peer could
        // deliver this CG's content. Show targeted copy + the same
        // signed-join-request CTA so the user can ping a curator
        // who is currently offline. Distinct from `accessDenied`
        // (responder refused) and `timedOut` (UI poll ceiling hit
        // before the daemon decided).
        setUnreachable(true);
        setProgress('');
        return;
      }

      if (catchup.status === 'failed') {
        setError(catchup.error || 'Sync failed');
        setProgress('');
        return;
      }

      if (catchup.status === 'timeout') {
        // A poll timeout is NOT evidence of ACL denial — it just means
        // no peer finished the catchup within ~90s. Common reasons:
        //   - project is public but peers are slow / offline,
        //   - network path is congested,
        //   - our subscribe hasn't reached a peer that holds the CG yet.
        // Flipping `accessDenied` here used to push users of public
        // projects straight into the "Access Restricted — send signed
        // join request" flow, which is misleading and cuts them off
        // from just retrying. Surface a neutral network error instead
        // and let them retry; a real ACL denial lands in the `denied`
        // branch above, or in the `err.message` check at the bottom
        // of this function. (HEAD tier-4c G3; v10-rc's copy "syncing
        // still in progress" was milder but still implied success —
        // we'd rather the user retry explicitly than think the subscribe
        // finished when the background sync never landed data.)
        setError(
          'Timed out waiting for peers to respond. The project may be slow to catch up, or no peer currently holds the data. Try again in a moment.',
        );
        setTimedOut(true);
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
      // Phase 8: transition into wire-workspace step instead of
      // auto-closing. The joiner can either install workspace files
      // for Cursor or click Skip if they're only subscribing.
      setWiredProjectName(joined?.name ?? cgId);
      setWiredCgId(cgId);
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
    const invite = parseInviteCode(inviteCode);
    const inviteError = validateInvite(invite);
    if (inviteError) {
      setError(inviteError);
      return;
    }
    const { cgId, curatorPeerId, legacyMultiaddr } = invite;

    setSendingRequest(true);
    setError(null);

    try {
      if (curatorPeerId) {
        try {
          await connectToPeerIdWithTimeout(curatorPeerId);
          await new Promise(r => setTimeout(r, 500));
        } catch {
          // Non-fatal — signed join requests can still be delivered via existing peers.
        }
      } else if (legacyMultiaddr) {
        try {
          await connectToPeerWithTimeout(legacyMultiaddr);
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

  function handleWireDone() {
    setWiredCgId(null);
    setWiredProjectName('');
    onClose();
  }

  if (wiredCgId) {
    return (
      <div className="v10-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleWireDone(); }}>
        <div className="v10-modal-box">
          <div className="v10-modal-header">
            <div className="v10-modal-title">Wire workspace for {wiredProjectName}</div>
            <div className="v10-modal-subtitle">
              Subscribed and synced. Now wire a local workspace so this Cursor can collaborate on the project.
            </div>
          </div>
          <div className="v10-modal-body">
            <WireWorkspacePanel
              contextGraphId={wiredCgId}
              projectName={wiredProjectName}
              variant="join"
              onDone={handleWireDone}
            />
          </div>
        </div>
      </div>
    );
  }

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

          {unreachable && !accessDenied && !requestSent && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.2)',
              color: 'var(--text-secondary, #94a3b8)',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Couldn't reach the curator</div>
              We subscribed locally, but no peer was able to deliver this project's data.
              The curator may be offline, or no node currently holds the data. You can still
              send a <strong>signed join request</strong> — they'll see it next time they come online.
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

          {timedOut && !unreachable && !accessDenied && !requestSent && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(148, 163, 184, 0.08)', border: '1px solid rgba(148, 163, 184, 0.25)',
              color: 'var(--text-secondary, #94a3b8)',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>If this project is curated…</div>
              The timeout above may also indicate this is a private project where your agent
              isn't yet on the allowlist. If retrying doesn't help, you can send a{' '}
              <strong>signed join request</strong> to the curator instead.
              <div style={{ marginTop: 8 }}>
                <button
                  className="v10-modal-btn"
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
              placeholder={"Paste the invite code from the project curator.\n\ne.g.\nmy-project-abc123\n12D3KooW..."}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoFocus
              rows={3}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
              The invite code contains a project ID and the curator's libp2p peer id. Legacy invites
              with an embedded multiaddr still work but are deprecated — relay rotations break them.
            </div>
          </div>

          <div className="v10-modal-tip">
            <div className="v10-modal-tip-title">How it works</div>
            Your node looks up the curator's current addresses on the libp2p Kademlia DHT, dials them,
            subscribes to the project, and starts syncing knowledge assets. For curated projects, the
            curator must approve your join request first. All requests are signed with your agent's
            wallet key to verify your identity.
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
