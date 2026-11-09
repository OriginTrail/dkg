import { useAgentsStore } from '../stores/agents.js';
import { api } from '../api-wrapper.js';
import { NODE_STATUS_POLL_MS, headerNodeStatus, isNodeStatusFailure } from '../lib/formatPeerStatus.js';
import { useVisibilityPolling } from './useVisibilityPolling.js';

/** The live node status, shared so the header and Settings can't disagree. */
export function useNodeState() {
  const nodeStatus = useAgentsStore((s) => s.nodeStatus);
  const failures = useAgentsStore((s) => s.nodeStatusFailures);
  const peers: number = nodeStatus?.connectedPeers ?? nodeStatus?.peerCount ?? 0;
  return { nodeStatus, peers, state: headerNodeStatus(nodeStatus != null, peers, failures) };
}

/**
 * Polls the node for the shell. A good check stores the status and clears the
 * failure count; a failed one adds to it; a 401 clears it, because the node
 * answered. The poll pauses while the tab is hidden (BUG-007).
 */
export function useNodeStatusPolling() {
  const setNodeStatus = useAgentsStore((s) => s.setNodeStatus);
  const recordNodeStatusFailure = useAgentsStore((s) => s.recordNodeStatusFailure);
  const clearNodeStatusFailures = useAgentsStore((s) => s.clearNodeStatusFailures);
  useVisibilityPolling(() => {
    api.fetchStatus().then(setNodeStatus).catch((error) => {
      if (isNodeStatusFailure(error)) recordNodeStatusFailure();
      else clearNodeStatusFailures();
    });
  }, NODE_STATUS_POLL_MS);
}
