import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';

const legacy: WorkspacePublicSnapshotStore = {
  putSnapshot: async ({ digest }) => ({ ref: digest, byteLength: 0 }),
  getSnapshot: async () => [],
};
const capable: WorkspacePublicSnapshotStore = {
  ...legacy,
  validateSnapshot: async (_ref, _digest, count) => count === 0,
};
if (capable.validateSnapshot) {
  const valid: Promise<boolean> = capable.validateSnapshot('ref', 'digest', 0);
  void valid;
  // @ts-expect-error Counts are numeric, not wire literals.
  capable.validateSnapshot('ref', 'digest', '0');
  // @ts-expect-error Expected digest is required.
  capable.validateSnapshot('ref', 0);
}
void legacy;
