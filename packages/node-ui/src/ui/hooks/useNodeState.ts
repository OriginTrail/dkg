import { useAgentsStore } from '../stores/agents.js';
import { headerNodeStatus } from '../lib/formatPeerStatus.js';

/** The live node status, shared so the header and Settings can't disagree. */
export function useNodeState() {
  const nodeStatus = useAgentsStore((s) => s.nodeStatus);
  const failures = useAgentsStore((s) => s.nodeStatusFailures);
  const peers: number = nodeStatus?.connectedPeers ?? nodeStatus?.peerCount ?? 0;
  return { nodeStatus, peers, state: headerNodeStatus(nodeStatus != null, peers, failures) };
}
