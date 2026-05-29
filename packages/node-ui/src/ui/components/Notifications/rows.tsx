/**
 * Row components for the redesigned notifications pane (ui-brief §4.4).
 *
 * Three presentational row kinds, all pure (data + callbacks in, JSX out):
 *  - `JoinRequestRow`     — actionable; inline Approve / two-tap Deny / Open.
 *  - `ActivityDigestRow`  — informational; collapsed per-(CG × kind) digest.
 *  - `ConfirmationRow`    — informational; own join approved / rejected.
 *
 * B2 establishes the structure + visual anatomy + the baseline interaction
 * (Approve/Deny call the hook, in-flight lock, terminal/retry/already-handled
 * states). B3 deepens the read-model wiring + a11y polish; seams are marked
 * `// B3:`.
 */
import React, { useState } from 'react';
import { formatNotificationTimestamp } from '../../lib/formatTimestamp.js';
import type {
  JoinRequestItem,
  ActivityItem,
  ActionResult,
} from '../../hooks/useNotificationsFeed.js';

/** `shortId` — never render a blank CG name (ui-brief §3 / UX §3). */
function cgLabel(name: string | undefined, cgId: string): string {
  if (name && name.trim()) return name;
  return cgId.length > 20 ? `${cgId.slice(0, 16)}…` : cgId;
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

// ─── Join request (actionable) ──────────────────────────────────────────────

/** Per-row interaction state machine. `idle` → `confirming-deny` (two-tap) →
 *  `working` → `done`/`error`. Kept local to the row so a failure on one row
 *  never disturbs siblings (ui-brief §5.3). */
type JoinRowPhase =
  | { kind: 'idle' }
  | { kind: 'confirming-deny' }
  | { kind: 'working'; action: 'approve' | 'deny' }
  | { kind: 'done'; label: string }
  | { kind: 'error'; action: 'approve' | 'deny'; message: string };

export function JoinRequestRow({
  item,
  onApprove,
  onDeny,
  onOpen,
}: {
  item: JoinRequestItem;
  onApprove: (cgId: string, agentAddress: string) => Promise<ActionResult>;
  onDeny: (cgId: string, agentAddress: string) => Promise<ActionResult>;
  onOpen: (cgId: string) => void;
}) {
  const [phase, setPhase] = useState<JoinRowPhase>({ kind: 'idle' });
  const cg = cgLabel(item.contextGraphName, item.cgId);
  const who = item.agentName?.trim() || shortAddr(item.agentAddress);

  const run = async (action: 'approve' | 'deny') => {
    setPhase({ kind: 'working', action });
    const fn = action === 'approve' ? onApprove : onDeny;
    const result = await fn(item.cgId, item.agentAddress);
    if (result.ok) {
      // Momentary terminal confirmation line; the reconciled feed drops the
      // row on the next load (ui-brief §4.4 / §5.3, UX §6 option b).
      const label = result.alreadyHandled
        ? 'Already handled'
        : action === 'approve'
          ? `Approved — ${who} can now access ${cg}`
          : `Request from ${who} declined`;
      setPhase({ kind: 'done', label });
    } else {
      const message = result.roleError
        ? `You're no longer the curator of ${cg}`
        : action === 'approve'
          ? 'Couldn’t approve'
          : 'Couldn’t deny';
      setPhase({ kind: 'error', action, message });
    }
  };

  if (phase.kind === 'done') {
    return (
      <div className="v10-notif-row v10-notif-row-terminal" role="status" aria-live="polite">
        <span className="v10-notif-glyph" aria-hidden="true">✓</span>
        <span className="v10-notif-terminal-text">{phase.label}</span>
      </div>
    );
  }

  const working = phase.kind === 'working';

  return (
    <div className="v10-notif-row v10-notif-row-join">
      <span className="v10-notif-glyph v10-notif-glyph-join" aria-hidden="true">🔑</span>
      <div className="v10-notif-row-body">
        <div className="v10-notif-row-title">Join request</div>
        <div className="v10-notif-row-detail">
          <span className="v10-notif-actor">{who}</span> wants to join{' '}
          <button
            type="button"
            className="v10-notif-cg-link"
            onClick={() => onOpen(item.cgId)}
            title={`Open ${cg}`}
          >
            {cg}
          </button>
        </div>
        <div className="v10-notif-row-sub">
          <span className="v10-notif-addr" title={item.agentAddress}>{shortAddr(item.agentAddress)}</span>
          <span className="v10-notif-dot">·</span>
          <span className="v10-notif-time" title={new Date(item.ts).toLocaleString()}>
            {formatNotificationTimestamp(item.ts)}
          </span>
        </div>
        {phase.kind === 'error' && (
          <div className="v10-notif-row-error" role="status" aria-live="polite">
            {phase.message}{' '}
            <button type="button" className="v10-notif-retry" onClick={() => run(phase.action)}>
              Retry
            </button>
          </div>
        )}
        {/* Visually-hidden in-flight announcement so SR users hear the action
            registered (the spinner glyph alone is sighted-only). */}
        <span className="v10-sr-only" role="status" aria-live="polite">
          {working ? (phase.action === 'approve' ? 'Approving…' : 'Denying…') : ''}
        </span>
      </div>
      <div className="v10-notif-row-actions">
        {phase.kind === 'confirming-deny' ? (
          // Inline one-step confirm (never a modal). Focus defaults to Cancel
          // (safe default). Escape cancels (and stops the event so the pane's
          // global Escape handler doesn't also close the whole dropdown);
          // focus leaving the group dismisses it (dismiss-on-blur).
          <span
            className="v10-notif-deny-confirm"
            role="group"
            aria-label="Confirm deny"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setPhase({ kind: 'idle' });
              }
            }}
            onBlur={(e) => {
              // Only dismiss when focus leaves the group entirely (tabbing
              // between Yes/Cancel keeps relatedTarget inside).
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setPhase({ kind: 'idle' });
              }
            }}
          >
            <span className="v10-notif-deny-confirm-label">Deny?</span>
            <button
              type="button"
              className="v10-notif-btn v10-notif-btn-deny"
              onClick={() => run('deny')}
              aria-label={`Confirm deny join request from ${who} for ${cg}`}
            >
              Yes
            </button>
            <button
              type="button"
              className="v10-notif-btn v10-notif-btn-ghost"
              onClick={() => setPhase({ kind: 'idle' })}
              autoFocus
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              className="v10-notif-btn v10-notif-btn-approve"
              onClick={() => run('approve')}
              disabled={working}
              aria-label={`Approve join request from ${who} for ${cg}`}
            >
              {working && phase.action === 'approve' ? '…' : 'Approve'}
            </button>
            <button
              type="button"
              className="v10-notif-btn v10-notif-btn-ghost"
              onClick={() => setPhase({ kind: 'confirming-deny' })}
              disabled={working}
              aria-label={`Deny join request from ${who} for ${cg}`}
            >
              {working && phase.action === 'deny' ? '…' : 'Deny'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Activity digest (informational) ────────────────────────────────────────

const ACTIVITY_GLYPH: Record<'created' | 'promoted' | 'published', string> = {
  created: '+',
  promoted: '⇡',
  published: '◉',
};

/** Digest copy per kind, with singular/plural (mirrors ActivityFeed).
 *  Exported for unit tests. */
export function digestText(event: 'created' | 'promoted' | 'published', count: number, actor?: string): string {
  const n = count;
  const noun = n === 1 ? 'assertion' : 'assertions';
  if (event === 'created') {
    return actor ? `${actor} added ${n} ${noun}` : `${n} new ${noun} added`;
  }
  if (event === 'promoted') {
    return actor ? `${actor} promoted ${n} ${noun}` : `${n} ${noun} promoted`;
  }
  return actor
    ? `${actor} published ${n} ${noun} to Verifiable Memory`
    : `${n} ${noun} published to Verifiable Memory`;
}

export function ActivityDigestRow({
  item,
  onOpen,
}: {
  // Narrowed to the digest variant by the pane before rendering.
  item: Extract<ActivityItem, { kind: 'digest' }>;
  onOpen: (cgId: string) => void;
}) {
  const cg = cgLabel(item.contextGraphName, item.cgId);
  const actor = item.actorAgentName?.trim() || undefined;
  const text = digestText(item.event, item.count, actor);
  const when = formatNotificationTimestamp(item.ts);
  // Descriptive accessible name carries the full meaning (kind + count + CG +
  // time) so the row never relies on the colour/glyph alone (a11y, UX §9).
  const ariaLabel = `${text} in ${cg}${when ? `, ${when}` : ''}. Open ${cg} recent activity.`;
  return (
    <button
      type="button"
      className={`v10-notif-row v10-notif-row-activity v10-notif-activity-${item.event}${item.read ? '' : ' v10-notif-unread'}`}
      onClick={() => onOpen(item.cgId)}
      title={`Open ${cg} · recent activity`}
      aria-label={ariaLabel}
    >
      <span className={`v10-notif-glyph v10-notif-glyph-${item.event}`} aria-hidden="true">
        {ACTIVITY_GLYPH[item.event]}
      </span>
      <span className="v10-notif-row-body" aria-hidden="true">
        <span className="v10-notif-row-detail">{text} in <span className="v10-notif-cg-name">{cg}</span></span>
      </span>
      <span className="v10-notif-time" aria-hidden="true" title={new Date(item.ts).toLocaleString()}>
        {when}
      </span>
    </button>
  );
}

// ─── Confirmation (informational) ───────────────────────────────────────────

export function ConfirmationRow({
  item,
  onOpen,
}: {
  item: Extract<ActivityItem, { kind: 'join_approved' | 'join_rejected' }>;
  onOpen: (cgId: string) => void;
}) {
  const cg = cgLabel(item.contextGraphName, item.cgId);
  const approved = item.kind === 'join_approved';

  const body = (
    <>
      <span
        className={`v10-notif-glyph ${approved ? 'v10-notif-glyph-approved' : 'v10-notif-glyph-rejected'}`}
        aria-hidden="true"
      >
        {approved ? '✓' : '✕'}
      </span>
      <span className="v10-notif-row-body">
        <span className="v10-notif-row-title">{approved ? 'Request approved' : 'Request declined'}</span>
        <span className="v10-notif-row-detail">
          {approved
            ? <>You can now access <span className="v10-notif-cg-name">{cg}</span></>
            : <>Your request to join <span className="v10-notif-cg-name">{cg}</span> wasn’t approved</>}
        </span>
      </span>
      <span className="v10-notif-time" title={new Date(item.ts).toLocaleString()}>
        {formatNotificationTimestamp(item.ts)}
      </span>
    </>
  );

  // Approved opens the now-joined CG; rejected is a dead-end (non-clickable).
  if (approved) {
    const when = formatNotificationTimestamp(item.ts);
    return (
      <button
        type="button"
        className={`v10-notif-row v10-notif-row-confirm v10-notif-confirm-approved${item.read ? '' : ' v10-notif-unread'}`}
        onClick={() => onOpen(item.cgId)}
        title={`Open ${cg}`}
        aria-label={`Request approved: you can now access ${cg}${when ? `, ${when}` : ''}. Open ${cg}.`}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className={`v10-notif-row v10-notif-row-confirm v10-notif-confirm-rejected${item.read ? '' : ' v10-notif-unread'}`}
      aria-disabled="true"
    >
      {body}
    </div>
  );
}
