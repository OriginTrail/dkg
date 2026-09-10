import { describe, expect, it, vi } from 'vitest';
import {
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
} from '@origintrail-official/dkg-storage';
import {
  workspaceKnowledgeAssetHeadSubject,
} from '@origintrail-official/dkg-publisher';
import {
  createDurableFinalizationRecoveryEligibility,
} from '../src/finalization-recovery-eligibility.js';

const CONTEXT_GRAPH_ID = 'eligibility-graph';
const UAL = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7';

describe('durable finalization recovery eligibility', () => {
  it('recognizes a canonical SWM workspace head', async () => {
    const store = new OxigraphStore();
    const graph = new GraphManager(store).sharedMemoryMetaUri(CONTEXT_GRAPH_ID);
    await store.insert([{
      subject: workspaceKnowledgeAssetHeadSubject(UAL),
      predicate: 'http://dkg.io/ontology/shareOperationId',
      object: '"share-1"',
      graph,
    }]);

    await expect(createDurableFinalizationRecoveryEligibility({ store })({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: UAL,
    })).resolves.toBe(true);
  });

  it('recognizes durable VM metadata without an SWM head', async () => {
    const store = new OxigraphStore();
    await store.insert([{
      subject: UAL,
      predicate: 'http://dkg.io/ontology/transactionHash',
      object: `"0x${'ab'.repeat(32)}"`,
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    }]);

    await expect(createDurableFinalizationRecoveryEligibility({ store })({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: UAL,
    })).resolves.toBe(true);
  });

  it('recognizes only the requested target-context VM metadata', async () => {
    const store = new OxigraphStore();
    await store.insert([{
      subject: UAL,
      predicate: 'http://dkg.io/ontology/transactionHash',
      object: `"0x${'cd'.repeat(32)}"`,
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID, '42'),
    }]);

    const eligible = createDurableFinalizationRecoveryEligibility({ store });
    await expect(eligible({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: UAL,
      targetContextGraphId: '42',
    })).resolves.toBe(true);
    await expect(eligible({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: UAL,
      targetContextGraphId: '43',
    })).resolves.toBe(false);
  });

  it('rejects an absent local durable record', async () => {
    const store = new OxigraphStore();
    await expect(createDurableFinalizationRecoveryEligibility({ store })({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: UAL,
    })).resolves.toBe(false);
  });

  it('fails open and reports probe errors', async () => {
    const store = new OxigraphStore();
    store.query = async () => {
      throw new Error('temporary store outage');
    };
    const onProbeError = vi.fn();

    await expect(createDurableFinalizationRecoveryEligibility({ store })({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: UAL,
      onProbeError,
    })).resolves.toBe(true);
    expect(onProbeError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'temporary store outage',
    }));
  });
});
