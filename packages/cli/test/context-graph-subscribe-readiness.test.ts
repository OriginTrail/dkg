import { describe, expect, it } from 'vitest';
import {
  cleanEmptyResult,
  privateDataOnlyResult,
  privateMetaOnlyResult,
  privateSharedMemoryOnlyResult,
  publicDurableAndSharedMemoryResult,
} from './helpers/context-graph-catchup-fixtures.js';
import { runSubscribeScenario as subscribe } from './helpers/context-graph-subscribe-route-harness.js';

describe('context graph subscribe readiness requires authoritative metadata', () => {
  it('keeps omitted sync mode backward-compatible as always-on', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
    });

    expect(result.response.syncMode).toBe('always-on');
    expect(result.subscribeCalls).toEqual([
      { id: expect.any(String), options: { syncMode: 'always-on' } },
    ]);
    expect(result.state.syncMode).toBe('always-on');
  });

  it('forwards explicit on-demand edge intent without making it always-on', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      syncMode: 'on-demand',
    });

    expect(result.response.syncMode).toBe('on-demand');
    expect(result.subscribeCalls).toEqual([
      { id: expect.any(String), options: { syncMode: 'on-demand' } },
    ]);
    expect(result.state.syncMode).toBe('on-demand');
  });

  it('reports the agent-applied mode when an on-demand open cannot downgrade always-on', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      syncMode: 'on-demand',
      initial: {
        subscribed: true,
        syncMode: 'always-on',
        synced: false,
      },
    });

    expect(result.subscribeCalls).toEqual([
      { id: expect.any(String), options: { syncMode: 'on-demand' } },
    ]);
    expect(result.response.syncMode).toBe('always-on');
    expect(result.state.syncMode).toBe('always-on');
  });

  it('rejects unknown sync modes before changing subscription state', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      syncMode: 'sometimes',
    });

    expect(result.responseStatus).toBe(400);
    expect(result.response.error).toContain('Invalid "syncMode"');
    expect(result.subscribeCalls).toEqual([]);
    expect(result.runCalls).toBe(0);
  });

  it('does not turn a clean empty response with no authoritative metadata into ready state', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('authoritative context-graph metadata'),
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(result.patches).not.toContainEqual(expect.objectContaining({ synced: true }));
    expect(result.metadataCheckOptions).toContainEqual({
      rejectUnregisteredPlaceholder: true,
    });
  });

  it('bypasses synthetic done and heals poisoned ready flags when metaSynced is false', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: false,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(result.patches[0]).toEqual({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('revalidates a stale metaSynced=true bit before returning synthetic done', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('does not restore stale true provenance after metadata arrives during an unclean catch-up', async () => {
    const metadataOnlyUnclean = privateMetaOnlyResult();
    if (!metadataOnlyUnclean.diagnostics?.durable ||
      !metadataOnlyUnclean.diagnostics.sharedMemory ||
      !metadataOnlyUnclean.cleanPlaneCompletions) {
      throw new Error('catch-up diagnostics missing');
    }
    metadataOnlyUnclean.diagnostics.durable.timedOutPhases = 1;
    metadataOnlyUnclean.diagnostics.sharedMemory.emptyResponses = 0;
    metadataOnlyUnclean.cleanPlaneCompletions.sharedMemory.emptyPeers = 0;

    const result = await subscribe({
      hasConfirmedMeta: false,
      hasConfirmedMetaAfterCatchup: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: metadataOnlyUnclean,
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('clears stale v1 proof when subscription flags are already fail-closed', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      hasConfirmedMetaAfterCatchup: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: privateMetaOnlyResult(),
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        pendingMeta: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('metadata-only responses cannot prove'),
    });
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('keeps clean-empty completion valid when authoritative public metadata exists', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('done');
    expect(result.job.error).toBeUndefined();
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  it('backfills both public planes and exposes the completed subscription job through catchup status', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      // Publishing is allowlisted to a different wallet. Explicit public read
      // policy must still bypass the private membership gate.
      allowedAgents: ['0x1111111111111111111111111111111111111111'],
      callerAddress: '0x2222222222222222222222222222222222222222',
      result: publicDurableAndSharedMemoryResult(),
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.response.catchup).toMatchObject({
      status: 'queued',
      jobId: expect.any(String),
    });
    expect(result.runRequests).toEqual([{
      contextGraphId: result.response.subscribed,
      includeSharedMemory: true,
    }]);
    expect(result.statusResponse).toMatchObject({
      jobId: result.response.catchup.jobId,
      status: 'done',
      convergence: {
        state: 'complete',
        verified: {
          metadata: true,
          durable: true,
          sharedMemory: true,
        },
        missing: [],
        automaticRetryActive: true,
      },
      result: {
        dataSynced: 3,
        sharedMemorySynced: 4,
      },
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  // Issue #2006: an empty response cannot distinguish "hosts an empty graph"
  // from "never heard of this graph", so a clean-empty peer only proves the
  // plane when the whole round was content-free and failure-free. A denial or a
  // failed data-bearing peer means we did not hear from everyone.
  it('does not keep a public clean-empty peer valid when another peer denies', async () => {
    const mixed = cleanEmptyResult();
    mixed.connectedPeers = 2;
    mixed.totalPeers = 2;
    mixed.selectedPeers = 2;
    mixed.syncCapablePeers = 2;
    mixed.peersTried = 2;
    mixed.peersResponded = 2;
    mixed.denied = true;
    mixed.deniedPeers = 1;
    if (!mixed.diagnostics?.durable) throw new Error('durable diagnostics missing');
    mixed.diagnostics.durable.deniedPhases = 1;

    const result = await subscribe({
      hasConfirmedMeta: true,
      includeSharedMemory: false,
      result: mixed,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).not.toBe('done');
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({ synced: false });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('does not settle as done when a data-bearing peer failed and an unrelated peer answered empty', async () => {
    // The reported field shape: 122,705 data triples fetched, five failed
    // phases, nothing verified, and unrelated peers answering empty — which
    // previously settled the job as `done` with 1 KA out of 40.
    const masked = cleanEmptyResult();
    masked.connectedPeers = 6;
    masked.totalPeers = 6;
    masked.selectedPeers = 6;
    masked.syncCapablePeers = 6;
    masked.peersTried = 6;
    masked.peersResponded = 6;
    if (!masked.diagnostics?.durable) throw new Error('durable diagnostics missing');
    masked.diagnostics.durable.fetchedDataTriples = 122_705;
    masked.diagnostics.durable.failedPhases = 5;

    const result = await subscribe({
      hasConfirmedMeta: true,
      includeSharedMemory: false,
      result: masked,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).not.toBe('done');
    expect(result.state).toMatchObject({ synced: false });
    expect(result.readiness).toMatchObject({ durableVerified: false });
  });

  it('does not promote private data readiness from unrelated empty responders after metadata is local', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('cannot prove a private graph is fully synchronized'),
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
  });

  it('does not promote a private CG from metadata-only diagnostics without verified payload', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      result: privateMetaOnlyResult(),
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
  });

  it('keeps private durable-only catch-up partial when shared-memory sync was requested', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      result: privateDataOnlyResult(),
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('shared-memory catch-up did not complete'),
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: false,
    });
  });

  it('records clean private shared-memory progress without fabricating durable readiness', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      result: privateSharedMemoryOnlyResult(),
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('durable VM'),
    });
    expect(result.job.result).toMatchObject({
      dataSynced: 0,
      sharedMemorySynced: 4,
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: true,
    });
  });

  it('does not promote positive durable inserts when the plane also timed out', async () => {
    const partial = privateDataOnlyResult();
    if (!partial.diagnostics?.durable) throw new Error('durable diagnostics missing');
    if (!partial.cleanPlaneCompletions) throw new Error('clean completion proof missing');
    partial.diagnostics.durable.timedOutPhases = 1;
    partial.cleanPlaneCompletions.durable.verifiedDataPeers = 0;

    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: partial,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('did not complete without a timeout'),
    });
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('does not promote positive durable inserts when the plane was also denied', async () => {
    const partial = privateDataOnlyResult();
    if (!partial.diagnostics?.durable) throw new Error('durable diagnostics missing');
    if (!partial.cleanPlaneCompletions) throw new Error('clean completion proof missing');
    partial.denied = true;
    partial.deniedPeers = 1;
    partial.diagnostics.durable.deniedPhases = 1;
    partial.cleanPlaneCompletions.durable.verifiedDataPeers = 0;

    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: partial,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('promotes a clean private plane when another peer denies and times out', async () => {
    const mixed = privateDataOnlyResult();
    if (!mixed.diagnostics?.durable) throw new Error('durable diagnostics missing');
    mixed.denied = true;
    mixed.deniedPeers = 1;
    mixed.diagnostics.durable.deniedPhases = 1;
    mixed.diagnostics.durable.timedOutPhases = 1;

    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: mixed,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).toBe('done');
    expect(result.job.error).toBeUndefined();
    expect(result.state).toMatchObject({
      synced: true,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: false,
    });
  });

  it('forces a corrective catch-up for a confirmed private legacy row without provenance', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('only returns synthetic done when all ready flags include metaSynced=true', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('done');
    expect(result.runCalls).toBe(0);
    expect(result.job.status).toBe('done');
    expect(result.patches).toEqual([]);
  });
});
