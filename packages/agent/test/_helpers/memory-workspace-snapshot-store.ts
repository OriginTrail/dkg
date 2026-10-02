import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';

/** Captures the snapshot quads supplied by a writer. */
export class MemoryWorkspaceSnapshotStore implements WorkspacePublicSnapshotStore {
  readonly snapshots = new Map<string, Quad[]>();

  async putSnapshot(input: { readonly digest: string; readonly quads: readonly Quad[] }) {
    this.snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
    return { ref: input.digest, byteLength: 0 };
  }

  async getSnapshot(ref: string): Promise<Quad[] | null> {
    return this.snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null;
  }
}
