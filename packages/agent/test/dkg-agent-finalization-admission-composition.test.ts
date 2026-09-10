import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  workspaceWriteCoordinatorForStore,
} from '@origintrail-official/dkg-publisher';
import { SwmSubstrateMethods } from '../src/dkg-agent-swm-substrate.js';

const CONTEXT_GRAPH_ID = 'agent-admission-composition';
const UAL = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7';

describe('agent finalization admission composition', () => {
  it('builds the finalization handler in the agent canonical SWM lock domain', async () => {
    const store = new OxigraphStore();
    const writeLocks = new Map<string, Promise<void>>();
    const fakeAgent = {
      finalizationHandler: undefined,
      finalizationRuntime: undefined,
      store,
      writeLocks,
      chain: { chainId: 'none' },
      eventBus: undefined,
      getContextGraphOnChainId: vi.fn(async () => undefined),
      contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
      publisher: { clearPublishedKnowledgeAssetSwm: vi.fn() },
      retireFinalizedSwmTwinCandidate: vi.fn(),
      invalidateListContextGraphsCache: vi.fn(),
      log: { info: vi.fn() },
    };
    const handler = SwmSubstrateMethods.prototype.getOrCreateFinalizationHandler.call(
      fakeAgent as never,
    );
    const eligibility = (handler as unknown as {
      finalizationRecoveryEligibility: (input: {
        contextGraphId: string;
        ual: string;
      }) => Promise<boolean>;
    }).finalizationRecoveryEligibility;

    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const lockEntered = new Promise<void>((resolve) => { entered = resolve; });
    const lock = workspaceWriteCoordinatorForStore(store).withKnowledgeAsset({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
    }, async () => {
        entered();
        await blocked;
      });
    await lockEntered;

    let settled = false;
    const probe = eligibility({ contextGraphId: CONTEXT_GRAPH_ID, ual: UAL })
      .finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await lock;
    await expect(probe).resolves.toBe(false);
  });
});
