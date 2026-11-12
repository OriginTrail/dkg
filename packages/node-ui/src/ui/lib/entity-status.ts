import type { BadgeTone } from '../components/ds/Badge.js';

/**
 * The one status policy for decisions, tasks and pull requests, wherever
 * their status is shown (activity feed rows, generated entity cards). It
 * returns the shared badge tone directly:
 *   - done, accepted, merged: success;
 *   - proposed, open, in progress: warning (still moving);
 *   - rejected, superseded, cancelled, blocked, closed (unmerged): danger;
 *   - anything else: neutral.
 */
export function entityStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'accepted': case 'done': case 'merged': return 'success';
    case 'proposed': case 'in_progress': case 'open': return 'pending';
    case 'rejected': case 'superseded': case 'cancelled': case 'blocked': case 'closed': return 'danger';
    default: return 'neutral';
  }
}
