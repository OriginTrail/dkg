// Wire shapes for /api/identity/node-id (+ /sync) and their CLI rendering.
// bigint fields travel as decimal strings.

export type ProfileNodeIdStateWire = 'no-profile' | 'in-sync' | 'legacy' | 'other-peer';

export type ProfileNodeIdSyncOutcomeWire =
  | 'updated'
  | 'in-sync'
  | 'no-profile'
  | 'unsupported'
  | 'taken'
  | 'skipped-other-peer';

export interface ProfileNodeIdStatusWire {
  identityId: string;
  peerId: string;
  /** The canonical nodeId for `peerId`: UTF-8 bytes of the base58btc peer id, 0x hex. */
  expectedNodeId: string;
  onChainNodeId: string;
  /** The peer id the on-chain nodeId names, or null (e.g. a legacy random nodeId). */
  onChainPeerId: string | null;
  state: ProfileNodeIdStateWire;
  expectedNodeIdTaken: boolean | null;
  expectedNodeIdHolder: string | null;
  profile: {
    address: string;
    version: string | null;
    updateNodeIdSupported: boolean;
    requiredVersion: string;
  };
}

export interface ProfileNodeIdSyncWire {
  outcome: ProfileNodeIdSyncOutcomeWire;
  /** One operator-facing line explaining the outcome. */
  message: string;
  status: ProfileNodeIdStatusWire;
  txHash: string | null;
  blockNumber: number | null;
  signer: string | null;
}

const STATE_LINES: Record<ProfileNodeIdStateWire, string> = {
  'no-profile': 'no on-chain profile yet',
  'in-sync': "in sync: the on-chain nodeId is this node's peer id",
  legacy: 'not a peer id (legacy random nodeId); run "dkg identity sync-node-id"',
  'other-peer': 'names a different peer id; run "dkg identity sync-node-id" if this node replaced it',
};

/** `dkg identity node-id` output. */
export function formatProfileNodeIdStatus(status: ProfileNodeIdStatusWire): string[] {
  const profile = status.profile;
  const version = profile.version ? `v${profile.version}` : 'unknown version';
  const support = profile.updateNodeIdSupported
    ? 'can update nodeIds'
    : `cannot update nodeIds (needs Profile >= ${profile.requiredVersion})`;
  const lines = [
    `  Identity:          ${status.identityId === '0' ? '— (no on-chain profile)' : status.identityId}`,
    `  Peer id:           ${status.peerId}`,
    `  Expected nodeId:   ${status.expectedNodeId}`,
    `  On-chain nodeId:   ${status.onChainNodeId === '0x' ? '—' : status.onChainNodeId}`,
  ];
  if (status.onChainPeerId !== null) lines.push(`  On-chain peer id:  ${status.onChainPeerId}`);
  lines.push(`  State:             ${STATE_LINES[status.state]}`);
  if (status.expectedNodeIdTaken) {
    const holder = status.expectedNodeIdHolder === null ? 'another identity' : `identity ${status.expectedNodeIdHolder}`;
    lines.push(`  Conflict:          this node's peer id is already the nodeId of ${holder}`);
  }
  lines.push(`  Profile contract:  ${version} at ${profile.address}, ${support}`);
  return lines;
}
