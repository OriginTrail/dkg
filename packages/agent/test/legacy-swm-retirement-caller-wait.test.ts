// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3081 — a publication waited 10 to 30 s after finality for the retirement of the marker of
 * its shared copy, which queued behind receiver leases.
 *
 * These rows drive the agent's own `retireLegacySwmAfterVerifiedVmTwin`, the one method the
 * publish tails, the finalization handler and the sync requester call, against a real boundary
 * state. A lease held by the row stands for the receiver that proves a catalog transition.
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import type { AuthorCatalogScopeV1 } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import {
  LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS,
  LEGACY_SWM_RETIREMENT_REPEAT_BASE_MS,
  peekOwedLegacySwmRetirementsV1,
} from '../src/internal/owed-legacy-swm-retirements.js';
import { RFC64_LEGACY_SWM_FENCE_WAIT_LIMIT_MS } from '../src/rfc64/legacy-swm-boundary-fence-v1.js';
import {
  acquireRfc64LegacySwmBoundaryReceiverLeaseV1,
  initializeRfc64LegacySwmBoundaryV1,
  prepareRfc64LateLegacySwmBoundaryV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const GRAPH = `${AUTHOR}/published-into`;
const OTHER_GRAPH = `${AUTHOR}/received-from-a-peer`;
const UAL = `did:dkg:otp:20430/${AUTHOR}/1`;
const scopeOf = (contextGraphId: string) => Object.freeze({
  networkId: 'otp:20430',
  contextGraphId,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
}) as AuthorCatalogScopeV1;

const UAL_OF_ANOTHER_ASSET = `did:dkg:otp:20430/${AUTHOR}/2`;
const dirs: string[] = [];
const agents: DKGAgent[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => {})));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function secureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-retirement-wait-'));
  await chmod(dir, 0o700);
  dirs.push(dir);
  return dir;
}

/** One turn of the event loop, on the real clock. */
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turns = 0; turns < 2_000; turns += 1) {
    if (condition()) return;
    await turn();
  }
  throw new Error(`never happened: ${what}`);
}

/**
 * A created agent with a real boundary, started only when the row is about its stop. Its asset
 * was shared and published: the shared copy is gone, and the marker the share left is what the
 * retirement removes.
 */
async function publishedAsset(options: { started?: boolean } = {}) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'RetirementWaitNode',
    dataDir: await secureDir(),
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter: new NoChainAdapter(),
    nodeRole: 'edge',
    skills: [],
    rfc64CatalogActivation: { enabled: false },
  });
  agents.push(agent);
  if (options.started === true) await agent.start();
  const fenceLines: string[] = [];
  await initializeRfc64LegacySwmBoundaryV1(agent, await secureDir(), store, {
    onFenceEvent: (event) => fenceLines.push(`${event.kind}:${event.source}:${event.waitingOn ?? '-'}`),
  });
  const share = prepareRfc64LateLegacySwmBoundaryV1(agent, GRAPH, UAL, 'the-share', '1');
  await store.insert([...share.quads]);
  share.settle(true);

  const internals = agent as unknown as {
    log: { info: (ctx: unknown, line: string) => void; warn: (ctx: unknown, line: string) => void };
  };
  // The node makes its owner of retirements when the first one is asked for.
  const owner = () => peekOwedLegacySwmRetirementsV1(agent);
  // What the node logs about retirements it owes; its other lines are not this suite's.
  const lines: string[] = [];
  const keep = (level: string) => (_ctx: unknown, line: string): void => {
    if (line.startsWith('Legacy SWM boundary retirement')) lines.push(`${level} ${line}`);
  };
  vi.spyOn(internals.log, 'info').mockImplementation(keep('info'));
  vi.spyOn(internals.log, 'warn').mockImplementation(keep('warn'));
  return {
    agent,
    store,
    fenceLines,
    lines,
    owed: () => owner()?.owed ?? 0,
    running: () => owner()?.running ?? 0,
    /** What the node's stop does with the retirements it owns. */
    closeRetirements: () => agent.closeOwedLegacySwmRetirementsV1(),
    /** Hold the retirement at work: its read of the shared copy does not come back until released. */
    holdTheRead: () => {
      const query = store.query.bind(store);
      let finishRead!: () => void;
      const readHeld = new Promise<void>((resolve) => { finishRead = resolve; });
      const held = { reading: false, finishRead };
      vi.spyOn(store, 'query').mockImplementation(async (sparql, queryOptions) => {
        if (queryOptions?.source === 'agent.rfc64.legacySwmBoundary.finalizedVmGraph') {
          held.reading = true;
          await readHeld;
        }
        return query(sparql, queryOptions);
      });
      return held;
    },
    markers: () => readRfc64LegacySwmBoundaryCountV1(agent, GRAPH),
    retire: () => agent.retireLegacySwmAfterVerifiedVmTwin({
      contextGraphId: GRAPH,
      kaUal: UAL,
      assertionVersion: 1n,
    }),
  };
}

describe('the retirement of a published asset\'s legacy SWM marker', () => {
  it('is not delayed by a lease that holds another graph', async () => {
    const node = await publishedAsset();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(node.agent, scopeOf(OTHER_GRAPH));

    // On the real clock: the caller's wait of a second is never reached.
    const started = performance.now();
    await node.retire();
    expect(performance.now() - started).toBeLessThan(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS);

    expect(node.markers()).toBe(0);
    expect(node.owed()).toBe(0);
    expect(node.fenceLines).toEqual([]);
    lease.release();
  });

  it('holds its caller for a second at most while a lease holds its own graph, then retires the marker on its own', async () => {
    const node = await publishedAsset();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(node.agent, scopeOf(GRAPH));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let returned = false;
    const asked = node.retire().then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await asked;

    // The caller is free, and the marker is still there: its retirement waits for the lease.
    expect(node.markers()).toBe(1);
    expect(node.owed()).toBe(0);

    lease.release();
    await until(() => node.markers() === 0, 'the marker is retired after the lease');
    // It ran on its first attempt: nothing gave up, nothing was repeated, nothing was logged.
    expect(node.fenceLines).toEqual([]);
    expect(node.lines).toEqual([]);
    expect(node.owed()).toBe(0);
  });

  it('keeps the asset fenced after its caller has left, until the retirement has ended', async () => {
    const node = await publishedAsset();
    const held = node.holdTheRead();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const asked = node.retire();
    await until(() => held.reading, 'the retirement reads the shared copy');
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS);
    await asked;

    // A later share of the same asset meets the fence of its retirement. Another asset does not.
    expect(() => prepareRfc64LateLegacySwmBoundaryV1(node.agent, GRAPH, UAL, 'a-later-share', '2'))
      .toThrow(/retry promotion \(fence raised by finalized-vm-retirement on the asset, up \d+ ms\)$/);
    prepareRfc64LateLegacySwmBoundaryV1(node.agent, GRAPH, UAL_OF_ANOTHER_ASSET, 'another-share', '1')
      .settle(false);
    expect(node.markers()).toBe(1);

    held.finishRead();
    await until(() => node.markers() === 0, 'the marker is retired');
    // The fence dropped with the retirement: the later share is admitted now.
    prepareRfc64LateLegacySwmBoundaryV1(node.agent, GRAPH, UAL, 'a-later-share', '2').settle(false);
    expect(node.owed()).toBe(0);
    expect(node.lines).toEqual([]);
  });

  it('comes back for a retirement that gave up behind a lease, and says so', async () => {
    const node = await publishedAsset();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(node.agent, scopeOf(GRAPH));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const asked = node.retire();
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS);
    await asked;
    // The lease outlasts the fence's bound: the first attempt gives up with nothing retired.
    await vi.advanceTimersByTimeAsync(RFC64_LEGACY_SWM_FENCE_WAIT_LIMIT_MS);
    await until(() => node.owed() === 1, 'the retirement is owed a repeat');
    expect(node.fenceLines).toEqual(['wait-exceeded:finalized-vm-retirement:mutation-chain']);
    expect(node.markers()).toBe(1);
    const key = JSON.stringify([GRAPH, null, UAL, '1']);
    expect(node.lines).toEqual([
      `info Legacy SWM boundary retirement ${key} did not get its turn; repeat 1 in 30 s`,
    ]);

    lease.release();
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_REPEAT_BASE_MS);
    await until(() => node.owed() === 0, 'the repeat ended');
    expect(node.markers()).toBe(0);
    expect(node.lines[1]).toBe(`info Legacy SWM boundary retirement ${key} ended on repeat 1: retired`);
  });

  it('ends a retirement that still waits for its turn when the node stops, and owes it nothing more', async () => {
    const node = await publishedAsset();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(node.agent, scopeOf(GRAPH));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const asked = node.retire();
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS);
    await asked;
    expect(node.running()).toBe(1);

    // Nothing moves the clock here: the wait ends because the node stops, not at the fence's bound.
    await node.closeRetirements();
    expect(node.running()).toBe(0);
    expect(node.owed()).toBe(0);
    expect(node.fenceLines).toEqual([]);
    // Its fence is down, and the marker stays, as the marker of a retirement that gave up always did.
    lease.release();
    prepareRfc64LateLegacySwmBoundaryV1(node.agent, GRAPH, UAL, 'a-later-share', '2').settle(false);
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_REPEAT_BASE_MS);
    expect(node.markers()).toBe(1);
    expect(node.lines).toEqual([]);
  });

  it('drops the repeat of a retirement that gave up when the node stops', async () => {
    const node = await publishedAsset();
    const lease = await acquireRfc64LegacySwmBoundaryReceiverLeaseV1(node.agent, scopeOf(GRAPH));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const asked = node.retire();
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS + RFC64_LEGACY_SWM_FENCE_WAIT_LIMIT_MS);
    await asked;
    await until(() => node.owed() === 1, 'the retirement is owed a repeat');

    await node.closeRetirements();
    expect(node.owed()).toBe(0);

    lease.release();
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_REPEAT_BASE_MS);
    expect(node.markers()).toBe(1);
  });

  it('holds the stop of the node until a retirement that is at work has ended', async () => {
    const node = await publishedAsset({ started: true });
    const held = node.holdTheRead();

    const asked = node.retire();
    await until(() => held.reading, 'the retirement reads the shared copy');
    let stopped = false;
    const stopping = node.agent.stop().then(() => { stopped = true; });
    for (let turns = 0; turns < 200; turns += 1) await turn();
    // The store is still open: the retirement owns it until its reads and its delete are through.
    expect(stopped).toBe(false);
    expect(node.running()).toBe(1);

    held.finishRead();
    await stopping;
    await asked;
    expect(stopped).toBe(true);
    expect(node.running()).toBe(0);
    expect(node.markers()).toBe(0);
  });
});
