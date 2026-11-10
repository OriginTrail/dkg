import { useRef } from 'react';
import { useAgentsStore } from '../stores/agents.js';
import { api } from '../api-wrapper.js';
import { headerNodeStatus } from '../lib/formatPeerStatus.js';
import { NODE_STATUS_POLL_MS, isNodeStatusFailure } from '../lib/nodeStatusPolicy.js';
import { useVisibilityPolling } from './useVisibilityPolling.js';

/** The live node status, shared so the header and Settings can't disagree. */
export function useNodeState() {
  const nodeStatus = useAgentsStore((s) => s.nodeStatus);
  const failures = useAgentsStore((s) => s.nodeStatusFailures);
  const peers = nodeStatus?.connectedPeers ?? nodeStatus?.peerCount ?? 0;
  return { nodeStatus, peers, state: headerNodeStatus(nodeStatus != null, peers, failures) };
}

/**
 * Polls the node for the shell. A good check stores the status and clears the
 * failure count; a failed one adds to it; a 401 clears it, because the node
 * answered. The poll pauses while the tab is hidden (BUG-007).
 *
 * Checks can overlap (a slow one, then a tab coming back into view), so each
 * is numbered and only counts if no later check has already answered. An old
 * failure arriving after a newer success can't mark the node Unavailable. A
 * check whose polling run has ended (unmount, Strict Mode's replay) never counts.
 */
export function useNodeStatusPolling() {
  const setNodeStatus = useAgentsStore((s) => s.setNodeStatus);
  const recordNodeStatusFailure = useAgentsStore((s) => s.recordNodeStatusFailure);
  const clearNodeStatusFailures = useAgentsStore((s) => s.clearNodeStatusFailures);
  const started = useRef(0);
  const answered = useRef(0);

  useVisibilityPolling((signal) => {
    const check = ++started.current;
    const current = () => {
      if (signal.aborted || check < answered.current) return false;
      answered.current = check;
      return true;
    };
    api.fetchStatus().then((status) => {
      if (current()) setNodeStatus(status);
    }).catch((error) => {
      if (!current()) return;
      if (isNodeStatusFailure(error)) recordNodeStatusFailure();
      else clearNodeStatusFailures();
    });
  }, NODE_STATUS_POLL_MS);
}
