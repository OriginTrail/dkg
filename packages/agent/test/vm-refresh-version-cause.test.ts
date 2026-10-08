// SPDX-License-Identifier: Apache-2.0

/**
 * What a VM refresh attempt says when the chain adapter has no version view.
 *
 * The decision is not what these rows are about: the attempt retries after backoff, tested where
 * it always was (vm-refresh-after-update.test.ts, untouched). These rows pin what the retry
 * carries: the adapter's reason appended to its detail, the same report as a field, the one log
 * line per attempt that the lane already writes, and nothing different when the adapter says
 * nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildKnowledgeAssetUal,
  type KnowledgeAssetVersionSnapshotUnavailable,
} from '@origintrail-official/dkg-chain';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import { packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import { versionViewCause } from '../src/named-ka-recovery-diagnostics.js';
import { VmRefreshQueue, type VmRefreshDue } from '../src/vm-refresh.js';
import {
  AUTHOR,
  CHAIN_ID,
  NO_ENDPOINT_SERVES,
  NO_ENDPOINT_SERVES_WORDS,
  PUBLISHER,
  unavailableRead,
  type SnapshotRead,
} from './_helpers/named-ka-recovery-fixture.js';
import {
  REFUSING_ENDPOINT_REPORT,
  REFUSING_ENDPOINT_WORDS,
  adapterOverRefusingEndpoint,
  expectNoEndpointUrl,
} from './_helpers/refusing-endpoint-adapter.js';

const CG = '501';
const UAL = buildKnowledgeAssetUal(CHAIN_ID, AUTHOR, 1n);
const KA_ID = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR, kaNumber: 1n });
/** The root the copy holds, and the root an update announced. */
const ROOT_A = `0x${'aa'.repeat(32)}`;
const ROOT_B = `0x${'bb'.repeat(32)}`;

/** The retry detail and the fetch conflict as they read before a cause was appended. */
const NO_VIEW = 'no coherent chain view confirms the copy';
const NO_SNAPSHOT = `Knowledge Asset ${UAL} has no coherent on-chain version snapshot`;

const TARGET: VmRefreshDue = {
  localCgId: CG,
  ual: UAL,
  kaId: KA_ID,
  merkleRoot: ROOT_B,
  blockNumber: 150,
  failures: 0,
};
const LOCAL = { merkleRoot: ROOT_A, assertionVersion: 1n };

afterEach(() => {
  vi.useRealTimers();
});

/** The refresh check over a chain that has only the version read. */
function confirm(readKnowledgeAssetVersionSnapshot: SnapshotRead, signal?: AbortSignal) {
  return SwmHostModeMethods.prototype.confirmVmRefreshCurrentAtEventBlock.call(
    { chain: { readKnowledgeAssetVersionSnapshot } } as never,
    TARGET,
    LOCAL,
    () => true,
    signal,
  );
}

describe('VM refresh check — why there is no version view', () => {
  it('appends what the adapter reported, and carries it, still as a retry', async () => {
    await expect(confirm(unavailableRead(NO_ENDPOINT_SERVES))).resolves.toStrictEqual({
      kind: 'settled',
      attempt: {
        outcome: 'retry',
        detail: `${NO_VIEW}: ${NO_ENDPOINT_SERVES_WORDS}`,
        // The report itself, for a caller that needs the endpoints: nothing has to read the detail.
        versionViewUnavailable: NO_ENDPOINT_SERVES,
      },
    });
  });

  it('says exactly what it said before when the adapter reports nothing', async () => {
    await expect(confirm(async () => null)).resolves.toStrictEqual({
      kind: 'settled',
      attempt: { outcome: 'retry', detail: NO_VIEW },
    });
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
    // The chain package's own words for the report, whatever its reason is.
    expect(versionViewCause(report)).toMatch(/^: \S/);
    await expect(confirm(unavailableRead(report))).resolves.toStrictEqual({
      kind: 'settled',
      attempt: { outcome: 'retry', detail: `${NO_VIEW}${versionViewCause(report)}`, versionViewUnavailable: report },
    });
  });

  it('never decides from the report: a view settles the copy whatever was reported beside it', async () => {
    const view = { latestRoot: ROOT_A, rootCount: 1n, latestAuthor: AUTHOR, latestPublisher: PUBLISHER, blockNumber: 200 };
    const reportingBeside = (answer: typeof view): SnapshotRead => async (_kaId, options) => {
      options?.onUnavailable?.(NO_ENDPOINT_SERVES);
      return answer;
    };

    await expect(confirm(reportingBeside(view))).resolves.toStrictEqual({
      kind: 'settled',
      attempt: { outcome: 'current', detail: 'the copy holds the chain root and version' },
    });
    await expect(confirm(reportingBeside({ ...view, latestRoot: ROOT_B, rootCount: 2n }))).resolves.toStrictEqual({
      kind: 'newer',
      chainRoot: ROOT_B,
      rootCount: 2n,
    });
    await expect(confirm(reportingBeside({ ...view, blockNumber: 140 }))).resolves.toStrictEqual({
      kind: 'settled',
      attempt: { outcome: 'retry', detail: "the chain view at block 140 is behind the update's block 150" },
    });
  });

  it('still reads through the adapter itself, with its asset and its signal', async () => {
    const { signal } = new AbortController();
    const chain = {
      seen: [] as unknown[][],
      // A method that needs its adapter, as the real one does.
      async readKnowledgeAssetVersionSnapshot(...args: unknown[]) {
        this.seen.push(args);
        return null;
      },
    };

    await SwmHostModeMethods.prototype.confirmVmRefreshCurrentAtEventBlock.call(
      { chain } as never,
      TARGET,
      LOCAL,
      () => true,
      signal,
    );

    expect(chain.seen).toEqual([[KA_ID, { signal, onUnavailable: expect.any(Function) }]]);
  });

  it('from the chain adapter: names an endpoint that refuses the pinned read, and not its URL', async () => {
    const adapter = adapterOverRefusingEndpoint();

    const confirmed = await confirm(adapter.readKnowledgeAssetVersionSnapshot);

    expect(confirmed).toStrictEqual({
      kind: 'settled',
      attempt: {
        outcome: 'retry',
        detail: `${NO_VIEW}: ${REFUSING_ENDPOINT_WORDS}`,
        versionViewUnavailable: REFUSING_ENDPOINT_REPORT,
      },
    });
    // It answered the `latest` read: this is not an endpoint that is down.
    expect(adapter.latestReads()).toBeGreaterThan(0);
    expectNoEndpointUrl(JSON.stringify(confirmed));
  });
});

// ---------------------------------------------------------------------------
// The lane's log line
// ---------------------------------------------------------------------------

/**
 * The refresh worker over a host that carries only what one attempt touches up to its chain
 * evidence: a confirmed copy at `ROOT_A`, a queue with the default backoff, and a chain whose
 * live root read answers `liveRoot` and whose version read answers `null` with the report.
 */
function refreshWorker(liveRoot: string) {
  const lines = { info: [] as string[], warn: [] as string[] };
  const versionReads: unknown[][] = [];
  const queue = new VmRefreshQueue({
    maxEntries: 8,
    baseBackoffMs: 60_000,
    maxBackoffMs: 10 * 60_000,
    maxAgeMs: 24 * 60 * 60_000,
  });
  const failing = unavailableRead(NO_ENDPOINT_SERVES);
  const methods = SwmHostModeMethods.prototype;
  const host = {
    chain: {
      chainId: CHAIN_ID,
      getLatestMerkleRoot: async () => liveRoot,
      getKAContextGraphId: async () => BigInt(CG),
      readKnowledgeAssetVersionSnapshot: ((kaId, options) => {
        versionReads.push([kaId, options]);
        return failing(kaId, options);
      }) satisfies SnapshotRead,
    },
    vmRefreshQueue: queue,
    vmReconcilePhysicalRuns: new Set<Promise<unknown>>(),
    log: {
      debug: () => {},
      info: (_ctx: unknown, line: string) => { lines.info.push(line); },
      warn: (_ctx: unknown, line: string) => { lines.warn.push(line); },
    },
    readVmRefreshLocalState: async () => ({ kind: 'confirmed', ...LOCAL, staged: false }),
    // The exact fetch stops at its chain evidence, before it needs the finalizer.
    getOrCreateFinalizationHandler: () => ({}),
    refreshConfirmedVmCopy: methods.refreshConfirmedVmCopy,
    confirmVmRefreshCurrentAtEventBlock: methods.confirmVmRefreshCurrentAtEventBlock,
    runExactAssetFetchForContextGraph: methods.runExactAssetFetchForContextGraph,
  };
  queue.offer({ localCgId: CG, ual: UAL, kaId: KA_ID, merkleRoot: ROOT_B, blockNumber: 150 });
  const pass = () => methods.runVmRefreshesForCg.call(host as never, CG, CG, () => true);
  return { pass, queue, lines, versionReads };
}

describe('VM refresh worker — the line of an attempt without a version view', () => {
  const START = new Date('2026-10-08T12:00:00.000Z').getTime();

  it('says why the pinned view is missing, once per attempt, on the usual backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    // The live read still answers the copy's root, so only a pinned view can settle the copy.
    const { pass, queue, lines, versionReads } = refreshWorker(ROOT_A);
    const firstLine = `VM refresh of ${UAL} in "${CG}" did not complete (${NO_VIEW}: `
      + `${NO_ENDPOINT_SERVES_WORDS}); retrying in 60s`;

    await pass();

    expect(lines).toEqual({ info: [firstLine], warn: [] });
    expect(versionReads).toHaveLength(1);
    expect(queue.snapshot()).toEqual([expect.objectContaining({ failures: 1, nextAttemptAt: START + 60_000 })]);

    // A pass before the target is due asks nothing and logs nothing.
    vi.setSystemTime(START + 59_000);
    await pass();
    expect(lines).toEqual({ info: [firstLine], warn: [] });
    expect(versionReads).toHaveLength(1);

    // The next attempt is one more line, and the delay doubles as it always did.
    vi.setSystemTime(START + 60_000);
    await pass();
    expect(lines).toEqual({
      info: [firstLine, firstLine.replace('retrying in 60s', 'retrying in 120s')],
      warn: [],
    });
    expect(queue.snapshot()).toEqual([expect.objectContaining({ failures: 2, nextAttemptAt: START + 180_000 })]);
  });

  it('says why the exact fetch has no version snapshot, once per attempt, on the usual backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    // The live read sees the update, so the attempt goes to fetch it and needs the snapshot
    // as its evidence.
    const { pass, queue, lines, versionReads } = refreshWorker(ROOT_B);

    await pass();

    expect(lines).toEqual({
      info: [],
      warn: [
        `VM refresh of ${UAL} in "${CG}" did not complete (failed: ${NO_SNAPSHOT}: `
          + `${NO_ENDPOINT_SERVES_WORDS}); retrying in 60s`,
      ],
    });
    expect(versionReads).toHaveLength(1);
    expect(queue.snapshot()).toEqual([expect.objectContaining({ failures: 1, nextAttemptAt: START + 60_000 })]);
  });
});
