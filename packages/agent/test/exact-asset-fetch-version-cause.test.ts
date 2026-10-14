// SPDX-License-Identifier: Apache-2.0

/**
 * What the exact-asset fetch says when the chain adapter has no version snapshot.
 *
 * The decision is not what these rows are about: the fetch fails closed with the same conflict,
 * tested where it always was (exact-asset-fetch-service.test.ts, untouched). These rows pin what
 * that conflict carries: the adapter's reason appended to the message, the same report as a
 * field, and nothing different when the adapter says nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildKnowledgeAssetUal,
  type KnowledgeAssetVersionSnapshotUnavailable,
} from '@origintrail-official/dkg-chain';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import { packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import { versionViewCause } from '../src/named-ka-recovery-diagnostics.js';
import {
  ContextGraphAssetFetchConflictError,
  runExactAssetFetch,
  type ExactAssetFetchDependencies,
} from '../src/sync/exact-asset-fetch.js';
import {
  AUTHOR,
  CHAIN_ID,
  NO_ENDPOINT_SERVES,
  NO_ENDPOINT_SERVES_WORDS,
  PUBLISHER,
  SEAL_MERKLE_ROOT,
} from './_helpers/named-ka-recovery-fixture.js';
import {
  REFUSING_ENDPOINT_REPORT,
  REFUSING_ENDPOINT_WORDS,
  adapterOverRefusingEndpoint,
  expectNoEndpointUrl,
} from './_helpers/refusing-endpoint-adapter.js';

const CONTEXT_GRAPH = 'exact-fetch-cg';
const ON_CHAIN_ID = '9';
const UAL = buildKnowledgeAssetUal(CHAIN_ID, AUTHOR, 1n);
const KA_ID = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR, kaNumber: 1n });

/** The conflict as it read before a cause was appended. */
const NO_SNAPSHOT = `Knowledge Asset ${UAL} has no coherent on-chain version snapshot`;
const CONFLICT = { name: 'ContextGraphAssetFetchConflictError', code: 'ContextGraphAssetFetchConflict' };

const snapshot = () => ({
  latestRoot: SEAL_MERKLE_ROOT,
  rootCount: 3n,
  latestAuthor: AUTHOR,
  latestPublisher: PUBLISHER,
  blockNumber: 321,
});

type VersionRead = ExactAssetFetchDependencies['readKnowledgeAssetVersionSnapshot'];

/** The fetch's version read, answering `null` and reporting `report` when given one. */
const noSnapshot = (report?: KnowledgeAssetVersionSnapshotUnavailable): VersionRead =>
  async (_kaId, _signal, onUnavailable) => {
    if (report !== undefined) onUnavailable?.(report);
    return null;
  };

function fetchOne(overrides: Partial<ExactAssetFetchDependencies>) {
  return runExactAssetFetch({ contextGraphId: CONTEXT_GRAPH, requestedUals: [UAL] }, {
    chainId: CHAIN_ID,
    isCurrent: () => true,
    getKAContextGraphId: async () => BigInt(ON_CHAIN_ID),
    readKnowledgeAssetVersionSnapshot: async () => snapshot(),
    verifyLocalContextGraph: async () => true,
    inspectLocal: async () => 'present',
    resolvePeerIds: async () => [],
    preparePeer: async () => true,
    fetchFromPeer: async () => undefined,
    flush: async () => undefined,
    log: () => undefined,
    ...overrides,
  });
}

const rejection = (run: Promise<unknown>): Promise<unknown> => run.then(() => undefined, (error: unknown) => error);

describe('exact asset fetch — why there is no version snapshot', () => {
  it('appends what the adapter reported, and carries it, still as the same conflict', async () => {
    const inspectLocal = vi.fn(async () => 'present' as const);

    const conflict = await rejection(fetchOne({
      readKnowledgeAssetVersionSnapshot: noSnapshot(NO_ENDPOINT_SERVES),
      inspectLocal,
    }));

    expect(conflict).toBeInstanceOf(ContextGraphAssetFetchConflictError);
    expect(conflict).toMatchObject({
      ...CONFLICT,
      message: `${NO_SNAPSHOT}: ${NO_ENDPOINT_SERVES_WORDS}`,
      // The report itself, for a caller that needs the endpoints: nothing has to read the message.
      versionViewUnavailable: NO_ENDPOINT_SERVES,
    });
    expect(inspectLocal).not.toHaveBeenCalled();
  });

  it('says exactly what it said before when the adapter reports nothing', async () => {
    const conflict = await rejection(fetchOne({ readKnowledgeAssetVersionSnapshot: noSnapshot() }));

    expect(conflict).toBeInstanceOf(ContextGraphAssetFetchConflictError);
    expect(conflict).toMatchObject({ ...CONFLICT, message: NO_SNAPSHOT });
    expect((conflict as ContextGraphAssetFetchConflictError).versionViewUnavailable).toBeUndefined();
  });

  it.each<[string, KnowledgeAssetVersionSnapshotUnavailable]>([
    ["the node's own request budget", { reason: 'local-pressure', endpointCount: 3, endpoints: [] }],
    ['a storage binding that changed', { reason: 'storage-binding-changed', endpointCount: 3, endpoints: [] }],
    ['a read that was cut short', {
      reason: 'aborted',
      endpointCount: 2,
      endpoints: [{ position: 1, host: 'rpc.example', stage: 'pinned-read', failure: 'timeout' }],
    }],
  ])('passes on whatever the adapter gives as the reason: %s', async (_name, report) => {
    const conflict = await rejection(fetchOne({ readKnowledgeAssetVersionSnapshot: noSnapshot(report) }));

    // The chain package's own words for the report, whatever its reason is.
    expect(versionViewCause(report)).toMatch(/^: \S/);
    expect(conflict).toMatchObject({
      ...CONFLICT,
      message: `${NO_SNAPSHOT}${versionViewCause(report)}`,
      versionViewUnavailable: report,
    });
  });

  it('never decides from the report: a snapshot is used whatever was reported beside it', async () => {
    const result = await fetchOne({
      readKnowledgeAssetVersionSnapshot: async (_kaId, _signal, onUnavailable) => {
        onUnavailable?.(NO_ENDPOINT_SERVES);
        return snapshot();
      },
    });

    expect(result).toMatchObject({ status: 'current', items: [{ ual: UAL, status: 'already-present' }] });
  });

  it('a conflict about something else carries no report', async () => {
    const conflict = await rejection(fetchOne({
      getKAContextGraphId: async () => 0n,
      readKnowledgeAssetVersionSnapshot: noSnapshot(NO_ENDPOINT_SERVES),
    }));

    expect(conflict).toMatchObject({
      ...CONFLICT,
      message: `Knowledge Asset ${UAL} is not registered to a Context Graph`,
    });
    expect((conflict as ContextGraphAssetFetchConflictError).versionViewUnavailable).toBeUndefined();
  });

  it('still passes the read its asset and its signal', async () => {
    const { signal } = new AbortController();
    const read = vi.fn<VersionRead>(async () => null);

    await rejection(fetchOne({ signal, readKnowledgeAssetVersionSnapshot: read }));

    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]).toEqual([KA_ID, signal, expect.any(Function)]);
  });
});

describe('operator asset fetch — from the chain adapter to the conflict', () => {
  it('names an endpoint that refuses the pinned read, and not its URL', async () => {
    const adapter = adapterOverRefusingEndpoint();
    // The operator entry point over a host that carries only what the fetch touches before it
    // has its chain evidence. Its chain reads the version through the real adapter.
    const host = {
      started: true,
      vmReconcileRuntimeReady: true,
      graphScopedStoreClosed: false,
      vmReconcileRotationClosed: false,
      vmReconcileLifecycleGeneration: 1,
      vmReconcileLifecycleController: new AbortController(),
      vmReconcilePhysicalRuns: new Set<Promise<unknown>>(),
      subscribedContextGraphs: new Map([[CONTEXT_GRAPH, { subscribed: true, onChainId: ON_CHAIN_ID }]]),
      chain: {
        chainId: CHAIN_ID,
        getKAContextGraphId: async () => BigInt(ON_CHAIN_ID),
        readKnowledgeAssetVersionSnapshot: adapter.readKnowledgeAssetVersionSnapshot,
      },
      canReadContextGraph: async () => true,
      getOrCreateFinalizationHandler: () => ({}),
      log: { info: vi.fn(), warn: vi.fn() },
    };

    const conflict = await rejection(
      SwmHostModeMethods.prototype.fetchContextGraphAssets.call(host as never, CONTEXT_GRAPH, [UAL]),
    );

    expect(conflict).toBeInstanceOf(ContextGraphAssetFetchConflictError);
    expect(conflict).toMatchObject({
      ...CONFLICT,
      message: `${NO_SNAPSHOT}: ${REFUSING_ENDPOINT_WORDS}`,
      versionViewUnavailable: REFUSING_ENDPOINT_REPORT,
    });
    // It answered the `latest` read: this is not an endpoint that is down.
    expect(adapter.latestReads()).toBeGreaterThan(0);
    const { message, versionViewUnavailable } = conflict as ContextGraphAssetFetchConflictError;
    expectNoEndpointUrl(`${message}\n${JSON.stringify(versionViewUnavailable)}`);
  });
});
