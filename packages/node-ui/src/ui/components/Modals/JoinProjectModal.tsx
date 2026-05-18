import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchContextGraphs,
  signJoinRequest, submitJoinRequest, fetchCurrentAgent,
  connectToPeerWithTimeout, connectToPeerIdWithTimeout,
  HttpError,
} from '../../api.js';
import { useProjectsStore } from '../../stores/projects.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useNodeEvents } from '../../hooks/useNodeEvents.js';
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
  } else {
    // Legacy multiaddr invites still carry the curator peer id at the
    // tail (`/p2p/<peerId>`). Surface it so the join flow has the
    // V10-required curator binding even for legacy invites — without
    // this, `/request-join` would 400 with "Missing curatorPeerId" on
    // every curated-project legacy invite. PR #448 review (round 4).
    const p2pTail = legacyMultiaddr.match(/\/p2p\/([^/]+)$/);
    if (p2pTail && PEER_ID_RE.test(p2pTail[1])) {
      curatorPeerId = p2pTail[1];
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
  if (!invite.cgId) return 'Missing context graph ID';
  if (invite.hasUnparsedExtra) {
    return 'Invite contains a second line that is not a valid peer ID (12D3Koo…) or multiaddr (/ip4/…). Check for typos.';
  }
  // V10: every join requires a curator peer id (the daemon's
  // `/request-join` returns 400 when curatorPeerId is absent — see
  // `forwardJoinRequest`). A bare cgId would silently 400 here, so
  // reject it loudly with actionable copy. The old subscribe-to-public-CG
  // paste flow has been removed; users who want a public CG that hasn't
  // surfaced in the Oracle yet need to ask the creator for an invite.
  if (!invite.curatorPeerId && !invite.legacyMultiaddr) {
    return 'This invite is missing the curator peer id. Ask the curator to regenerate the invite from the Share Context Graph dialog.';
  }
  if (invite.legacyMultiaddr) {
    if (!invite.legacyMultiaddr.startsWith('/')) return 'Invalid curator multiaddr';
    if (!invite.legacyMultiaddr.includes('/p2p/')) return 'Curator multiaddr is missing peer ID';
  }
  return null;
}

/**
 * Render the user-visible error string for a failed /request-join call.
 *
 * The daemon's `POST /api/context-graph/{id}/request-join` returns a 502
 * with `{ error, errors? }` when `forwardJoinRequest` couldn't deliver:
 * `errors[]` carries the per-peer reason (e.g.
 * `"<peerTag>: verifyAgentDelegation: scope mismatch (expected … got …)"`
 * when the curator received the request but rejected it, or
 * `"<peerTag>: dial failed (…)"` when the transport never landed). The
 * previous UI swallowed `errors[]` and always showed "couldn't deliver
 * to any reachable curator", which is misleading for the by-far-most-
 * common failure mode — hub-address skew between joiner and curator
 * after a testnet contract redeployment leaves the joiner's network
 * config stale and the curator silently rejects every signed delegation.
 *
 * This helper:
 *   1. Distinguishes "reached but rejected" from "couldn't reach" by
 *      content of the per-peer entries (NOT by mere presence of a
 *      non-`dial failed` line — see below).
 *   2. Surfaces the underlying reason(s) verbatim so daemon-log
 *      spelunking isn't needed.
 *   3. Appends an actionable hint for known patterns. If any of those
 *      strings change in the daemon, the hint silently stops firing
 *      but the verbatim reason is still shown.
 *
 * Codex review on round 1 flagged that the original heuristic
 * (`some entry that is not "dial failed"`) incorrectly classified the
 * mixed case `["<curatorTag>: dial failed (timeout)",
 * "<otherPeer>: not curator", ...]` as a curator rejection. That
 * combination happens whenever the targeted curator dial times out and
 * `forwardJoinRequest` then broadcasts to other peers, none of which
 * curate the CG. The curator was never reached, so it must not be
 * shown as a rejection. We now look at the reason content (post-prefix)
 * and treat ONLY `dial failed (…)` and `not curator` as
 * delivery-failure signals; anything else is treated as a
 * curator-authoritative answer.
 *
 * Exported so it can be unit-tested without rendering the React tree.
 */
export function formatJoinRequestError(err: unknown): string {
  if (err instanceof HttpError && err.status === 502) {
    const perPeer = readPerPeerErrors(err.body);
    if (perPeer.length === 0) {
      return 'Request signed, but we couldn\'t deliver it to any reachable curator. ' +
        'Try again in a moment once your node has discovered more peers, or ask the curator for an updated invite.';
    }
    const reasons = perPeer.join('; ');
    const reachedAndRejected = perPeer.some(isCuratorAuthoritativeReason);
    const headline = reachedAndRejected
      ? 'Curator rejected this join request.'
      : 'Couldn\'t deliver this join request to the curator.';
    const hint = hintForJoinRejectReasons(reasons, reachedAndRejected);
    return hint
      ? `${headline} Reason: ${reasons}. ${hint}`
      : `${headline} Reason: ${reasons}.`;
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Failed to send join request';
}

function readPerPeerErrors(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter((e): e is string => typeof e === 'string' && e.length > 0);
}

/**
 * A per-peer entry from `forwardJoinRequest.errors[]` looks like
 * `"<peerTag>: <reason>"`. The known *non-authoritative* (delivery-failure)
 * reasons are:
 *   - `"dial failed (...)"` — only emitted by the targeted-dial path on
 *     transport error; the curator never saw the request.
 *   - `"not curator"`       — only emitted by broadcast cohort peers; we
 *     reached someone, but they don't curate this CG.
 * Anything else (`scope mismatch`, `unknown CG`, signature errors, …)
 * is a curator-authoritative reject — the curator received the
 * delegation and answered. Treat the entry as authoritative.
 */
function isCuratorAuthoritativeReason(entry: string): boolean {
  const reason = entry.replace(/^[^:]+:\s*/, '').trim();
  if (!reason) return false;
  if (/^dial failed\b/i.test(reason)) return false;
  if (/^not curator$/i.test(reason)) return false;
  return true;
}

function hintForJoinRejectReasons(reasons: string, reachedAndRejected: boolean): string | null {
  if (reachedAndRejected) {
    // `scope mismatch` is the on-the-wire wording from
    // `verifyAgentDelegation` (packages/agent/src/agent-delegation.ts).
    // It fires when the joiner's daemon signed the delegation against a
    // different ContextGraphsHub contract address than the curator's —
    // in practice almost always because the joiner's
    // `network/testnet.json` is still pointing at the pre-redeploy hub.
    if (/scope mismatch/i.test(reasons)) {
      return 'This usually means your daemon\'s network config has a stale ContextGraphsHub address — ' +
        'pull the latest release (or `git pull && pnpm install && pnpm run build:runtime`) and try again.';
    }
    if (/unknown CG/i.test(reasons)) {
      return 'The curator doesn\'t recognise this context graph id — double-check the invite, ' +
        'or ask the curator to share an updated one.';
    }
    return null;
  }
  // Delivery-failure case: curator was never reached. `not curator`
  // means the broadcast cohort had no curator in it; `dial failed`
  // means the targeted curator dial timed out / errored. In both cases
  // the most actionable advice is "make sure the curator's daemon is
  // online and the invite carries the right peer id".
  if (/not curator/i.test(reasons)) {
    return 'Your node reached other peers, but none of them curate this context graph. ' +
      'Make sure the curator\'s daemon is online and the invite carries the right curator peer id.';
  }
  return null;
}

type Phase = 'idle' | 'sending' | 'pending' | 'approved' | 'rejected';

export function JoinProjectModal({ open, onClose, initialContextGraphId }: JoinProjectModalProps) {
  const [inviteCode, setInviteCode] = useState(initialContextGraphId ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingCgId, setPendingCgId] = useState<string | null>(null);
  // Phase 8: after approval we transition into a wire-workspace step so
  // the joiner can populate a local Cursor workspace from the project's
  // manifest. `wiredCgId` flips the modal into the WireWorkspacePanel;
  // the operator can also click Skip if they only want to subscribe.
  const [wiredCgId, setWiredCgId] = useState<string | null>(null);
  const [wiredProjectName, setWiredProjectName] = useState<string>('');

  const { contextGraphs, setContextGraphs, setActiveProject } = useProjectsStore();
  const { openTab } = useTabsStore();

  useEffect(() => {
    if (initialContextGraphId) setInviteCode(initialContextGraphId);
  }, [initialContextGraphId]);

  useEffect(() => {
    if (!open) {
      setInviteCode(initialContextGraphId ?? '');
      setError(null);
      setPhase('idle');
      setPendingCgId(null);
    }
  }, [open, initialContextGraphId]);

  // Drive the post-approval flow: refresh the sidebar, focus the new
  // CG's tab, and hand off to the wire-workspace step. Idempotent —
  // safe to call from both the SSE join_approved handler and the
  // synchronous already-member short-circuit below. PR #448 review:
  // the curator's `join-approved` P2P notification is fire-and-forget
  // (`.catch(() => {})`), so the modal cannot rely on the SSE alone to
  // advance after an authoritative HTTP success.
  const transitionToApproved = useCallback(async (cgId: string) => {
    setPhase('approved');
    try {
      const { contextGraphs: freshList } = await fetchContextGraphs();
      setContextGraphs(freshList ?? []);
      const joined = freshList?.find((cg: any) => cg.id === cgId);
      if (joined) {
        setActiveProject(joined.id);
        openTab({ id: `project:${joined.id}`, label: joined.name || joined.id, closable: true });
        setWiredProjectName(joined.name ?? cgId);
        setWiredCgId(cgId);
      }
    } catch {
      // Sidebar refresh is best-effort; the user can still close the
      // modal and re-open the project from the (eventually-refreshed)
      // sidebar.
    }
  }, [setContextGraphs, setActiveProject, openTab]);

  // Auto-transition to wire-workspace when the curator approves a
  // pending request. The SSE event arrives when the daemon's
  // `JOIN_APPROVED` event bus fires for the cgId we're waiting on.
  const onNodeEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (!pendingCgId) return;
    if (event.type !== 'join_approved' && event.type !== 'join_rejected') return;
    const eventCgId = event.data?.contextGraphId;
    if (eventCgId !== pendingCgId) return;

    if (event.type === 'join_rejected') {
      setPhase('rejected');
      return;
    }

    void transitionToApproved(pendingCgId);
  }, [pendingCgId, transitionToApproved]);
  useNodeEvents(onNodeEvent);

  if (!open) return null;

  const handleRequestJoin = async () => {
    const invite = parseInviteCode(inviteCode);
    const inviteError = validateInvite(invite);
    if (inviteError) {
      setError(inviteError);
      return;
    }
    const { cgId, curatorPeerId, legacyMultiaddr } = invite;

    setError(null);

    // Pre-check: if we already have this CG locally (previous join, or
    // curator added us via add-agent), just open it. No need to re-sign
    // a delegation we don't need.
    const existing = contextGraphs.find((cg: any) => cg.id === cgId);
    if (existing) {
      setActiveProject(existing.id);
      openTab({ id: `project:${existing.id}`, label: existing.name || existing.id, closable: true });
      onClose();
      return;
    }

    setPhase('sending');

    try {
      // Warm the curator path so the daemon's targeted `forwardJoinRequest`
      // dial doesn't pay the full DHT-walk + relay-handshake cost. Best-
      // effort — the daemon will retry via DHT internally.
      if (curatorPeerId) {
        await connectToPeerIdWithTimeout(curatorPeerId).catch(() => {});
      } else if (legacyMultiaddr) {
        console.warn(
          '[DKG] This invite uses a legacy multiaddr (deprecated). Ask the curator to regenerate using the current Share Context Graph modal — V10 invites carry a peer id and resolve via DHT, so they survive relay rotations.',
        );
        await connectToPeerWithTimeout(legacyMultiaddr).catch(() => {});
      }

      const signed = await signJoinRequest(cgId);
      const agentName = await fetchCurrentAgent().then((i) => i.name).catch(() => undefined);

      const result = await submitJoinRequest(cgId, {
        delegation: signed.delegation,
        agentName,
        curatorPeerId: curatorPeerId ?? undefined,
      });

      setPendingCgId(cgId);

      if (result.alreadyMember) {
        // Curator-side short-circuit: requester is already in the
        // allowlist. The HTTP response is itself authoritative — the
        // curator's separate `join-approved` P2P notification is
        // fire-and-forget and may be dropped, so don't make the modal
        // depend on it. Drive the transition synchronously.
        await transitionToApproved(cgId);
        return;
      }

      setPhase('pending');
    } catch (err: unknown) {
      // `post()` throws `HttpError` for non-2xx, attaching the parsed
      // JSON body. For 502 the daemon includes `errors[]` with per-peer
      // reject reasons (`forwardJoinRequest` in
      // packages/cli/src/daemon/routes/context-graph.ts). Delegate the
      // copy to `formatJoinRequestError` so the underlying reason —
      // most commonly a delegation-scope mismatch from a stale hub
      // address — actually reaches the user instead of being smothered
      // under a generic "no reachable curator" message.
      setError(formatJoinRequestError(err));
      setPhase('idle');
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
              Curator approved. Now wire a local workspace so this Cursor can collaborate on the context graph.
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

  const sending = phase === 'sending';
  const pending = phase === 'pending';
  const approved = phase === 'approved';
  const rejected = phase === 'rejected';

  return (
    <div className="v10-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v10-modal-box">
        <div className="v10-modal-header">
          <div className="v10-modal-title">Join a Context Graph</div>
          <div className="v10-modal-subtitle">
            Paste the invite from the curator. Your node will send a signed join request and wait for approval.
          </div>
        </div>

        <div className="v10-modal-body">
          {error && <div className="v10-modal-error">{error}</div>}

          {pending && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.25)',
              color: 'var(--accent-primary, #3b82f6)',
            }}>
              Join request sent. Waiting for the curator to approve — this modal will move forward automatically once they do.
            </div>
          )}

          {approved && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.25)',
              color: 'var(--accent-green)',
            }}>
              Approved! Loading context graph…
            </div>
          )}

          {rejected && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
              background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)',
              color: 'var(--accent-warning, #f59e0b)',
            }}>
              The curator declined this join request.
            </div>
          )}

          <div className="v10-form-group">
            <label className="v10-form-label">Invite Code</label>
            <textarea
              className="v10-form-textarea"
              placeholder={"Paste the invite code from the context graph curator.\n\ne.g.\nmy-context-graph-abc123\n12D3KooW..."}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoFocus
              rows={3}
              disabled={sending || pending || approved}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
            />
          </div>
        </div>

        <div className="v10-modal-footer">
          <button className="v10-modal-btn" onClick={onClose}>{pending || approved ? 'Close' : 'Cancel'}</button>
          <button
            className="v10-modal-btn primary"
            onClick={handleRequestJoin}
            disabled={!inviteCode.trim() || sending || pending || approved}
          >
            {sending ? 'Sending request…' : pending ? 'Awaiting approval…' : approved ? 'Approved' : 'Request to Join'}
          </button>
        </div>
      </div>
    </div>
  );
}
