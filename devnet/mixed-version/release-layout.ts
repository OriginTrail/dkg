/** Exact-build release preflight for a cluster whose package versions can match. */
export interface ReleaseLayoutNode {
  readonly num: number;
  readonly role: string;
  readonly commit: string | null;
}

export function releaseLayoutFailures(
  nodes: readonly ReleaseLayoutNode[],
  expected: Readonly<{ coreCommit: string; edgeCommit: string }>,
): string[] {
  const failures: string[] = [];
  const sha = /^[0-9a-f]{40}$/i;
  if (!sha.test(expected.coreCommit)) failures.push('DKG_EXPECTED_CORE_COMMIT must be a full 40-character commit SHA');
  if (!sha.test(expected.edgeCommit)) failures.push('DKG_EXPECTED_EDGE_COMMIT must be a full 40-character commit SHA');
  if (failures.length > 0) return failures;
  if (expected.coreCommit.toLowerCase() === expected.edgeCommit.toLowerCase()) {
    failures.push('release core and edge commits must differ');
  }
  if (!nodes.some((node) => node.role === 'core')) failures.push('no core node observed');
  if (!nodes.some((node) => node.role === 'edge')) failures.push('no edge node observed');
  for (const node of nodes) {
    const wanted = node.role === 'core'
      ? expected.coreCommit
      : node.role === 'edge' ? expected.edgeCommit : undefined;
    if (wanted === undefined) {
      failures.push(`node${node.num} has unexpected role ${node.role}`);
    } else if (node.commit?.toLowerCase() !== wanted.toLowerCase()) {
      failures.push(`node${node.num} (${node.role}) reports commit ${node.commit ?? '<missing>'}; expected ${wanted}`);
    }
  }
  return failures;
}
