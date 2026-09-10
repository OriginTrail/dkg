import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { workspaceWriteCoordinatorForStore } from '../src/workspace-write-coordinator.js';

const COORDINATE = Object.freeze({
  contextGraphId: 'coordinator-cg',
  kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7',
});

describe('workspace write coordinator', () => {
  it('serializes components sharing a store while isolating distinct stores', async () => {
    const store = new OxigraphStore();
    const otherStore = new OxigraphStore();
    const first = workspaceWriteCoordinatorForStore(store);
    const second = workspaceWriteCoordinatorForStore(store);
    const other = workspaceWriteCoordinatorForStore(otherStore);
    expect(second).toBe(first);
    expect(other).not.toBe(first);

    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const holding = first.withKnowledgeAsset(COORDINATE, async () => {
      entered();
      await blocked;
    });
    await lockEntered;

    let sameStoreRan = false;
    const sameStore = second.withKnowledgeAsset(COORDINATE, async () => {
      sameStoreRan = true;
    });
    let otherStoreRan = false;
    await other.withKnowledgeAsset(COORDINATE, async () => {
      otherStoreRan = true;
    });
    expect(otherStoreRan).toBe(true);
    expect(sameStoreRan).toBe(false);

    release();
    await holding;
    await sameStore;
    expect(sameStoreRan).toBe(true);
  });
});
