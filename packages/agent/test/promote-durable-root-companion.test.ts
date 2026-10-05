// SPDX-License-Identifier: Apache-2.0

/**
 * A root promote that meets the RFC-64 legacy SWM retirement fence (another
 * asset's confirmed publish is retiring its marker on the same context graph)
 * is a retryable promote failure, not a terminal one.
 *
 * The first block drives the agent's REAL promote companion resolver (the
 * production lambda in `DKGAgent.create`, reached through the publisher the
 * agent built) against a real boundary state, so it fails on a build whose
 * lambda does not translate the fence. Expected codes are string literals and
 * only existing exports are used, so a build without the fix fails on the
 * behaviour, not on a missing import. The second block unit-tests the
 * translation helper itself.
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { getPromoteFailureDisposition } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import * as precommit from '../src/internal/promote/assertion-promote-precommit.js';
import * as boundary from '../src/rfc64/legacy-swm-boundary-v1.js';
import {
  initializeRfc64LegacySwmBoundaryV1,
  prepareRfc64LateLegacySwmBoundaryV1,
  readRfc64LegacySwmBoundaryCountV1,
  retireRfc64LegacySwmAfterFinalizedVmV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/promote-fence';
const AGENT_ADDRESS = '0x1111111111111111111111111111111111111111';
const UAL_A = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
const UAL_B = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/2';
const FENCE_CODE = 'RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS';
const FENCE_MESSAGE = 'RFC-64 legacy SWM boundary retirement is in progress; retry promotion';

const dirs: string[] = [];
const agents: DKGAgent[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => {})));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function secureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-promote-companion-'));
  await chmod(dir, 0o700);
  dirs.push(dir);
  return dir;
}

/** A created, never-started agent whose persistent boundary state may be initialized. */
async function createAgent(initializeBoundary: boolean) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'PromoteCompanionNode',
    dataDir: await secureDir(),
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter: new NoChainAdapter(),
    nodeRole: 'edge',
    skills: [],
  });
  agents.push(agent);
  if (initializeBoundary) {
    await initializeRfc64LegacySwmBoundaryV1(agent, await secureDir(), store);
  }
  const publisher = (agent as any).publisher;
  const identity = (kaUal: string, shareOperationId: string) => Object.freeze({
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate: 'promote-fence-asset',
    lifecycleAgentAddress: AGENT_ADDRESS,
    kaUal,
    assertionVersion: '1',
    shareOperationId,
  });
  return {
    agent,
    store,
    promoteCompanion: (kaUal: string, op: string) =>
      publisher.resolveDurableRootPromotionAtomicCompanion(identity(kaUal, op)),
    materializationCompanion: (kaUal: string, op: string) =>
      publisher.resolveDurableRootMaterializationAtomicCompanion(identity(kaUal, op)),
  };
}

function thrownBy(run: () => unknown): any {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('promote companion under the legacy SWM retirement fence (real agent wiring)', () => {
  it('turns the fence into a retryable promote failure the worker retries, then lets the retry through', async () => {
    const { agent, promoteCompanion } = await createAgent(true);
    // Asset A's retirement waits for an in-flight share of the same graph, so the fence is up.
    const inFlight = prepareRfc64LateLegacySwmBoundaryV1(agent, CONTEXT_GRAPH_ID, UAL_A, 'in-flight-share', '1');
    const retirement = retireRfc64LegacySwmAfterFinalizedVmV1(agent, CONTEXT_GRAPH_ID, UAL_A, '1');
    expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(1);

    const refusal = thrownBy(() => promoteCompanion(UAL_B, 'share-of-b'));

    // The canary failure is the plain message with no code; the fix is a typed retryable failure.
    expect(refusal.message).not.toContain('retry promotion');
    expect(refusal.code).toBe('PROMOTE_RETRYABLE_FAILURE');
    expect(refusal.cause.code).toBe(FENCE_CODE);
    expect(refusal.cause.message).toBe(FENCE_MESSAGE);
    expect(getPromoteFailureDisposition(refusal)).toMatchObject({
      classification: 'transient',
      retryable: true,
      diagnostic: { code: 'PROMOTE_RETRYABLE_FAILURE' },
    });
    // The rejected attempt registered nothing: only A's entry is outstanding.
    expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(1);

    inFlight.settle(false);
    await expect(retirement).resolves.toBe(false);
    const companion = promoteCompanion(UAL_B, 'share-of-b');
    expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(1);
    companion.settle(false);
  });

  it('retries into a finished retirement: the marker is retired, then the new share is tracked', async () => {
    const { agent, store, promoteCompanion } = await createAgent(true);
    // A was shared and is now published; its SWM graph and head are gone, its marker is not.
    const sharedA = prepareRfc64LateLegacySwmBoundaryV1(agent, CONTEXT_GRAPH_ID, UAL_A, 'share-of-a', '1');
    await store.insert([...sharedA.quads]);
    sharedA.settle(true);

    const query = store.query.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const insideAbsenceCheck = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      if (options?.source === 'agent.rfc64.legacySwmBoundary.finalizedVmGraph') {
        reached();
        await gate;
      }
      return query(sparql, options);
    });
    const retirement = retireRfc64LegacySwmAfterFinalizedVmV1(agent, CONTEXT_GRAPH_ID, UAL_A, '1');
    await insideAbsenceCheck;

    const refusal = thrownBy(() => promoteCompanion(UAL_B, 'share-of-b'));
    expect(refusal.code).toBe('PROMOTE_RETRYABLE_FAILURE');
    expect(refusal.cause.code).toBe(FENCE_CODE);
    expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(1);

    release();
    await expect(retirement).resolves.toBe(true);
    expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(0);
    const companion = promoteCompanion(UAL_B, 'share-of-b');
    expect(readRfc64LegacySwmBoundaryCountV1(agent, CONTEXT_GRAPH_ID)).toBe(1);
    companion.settle(false);
  });

  it('leaves the update-staging companion on the plain refusal (it has no retry consumer)', async () => {
    const { agent, materializationCompanion } = await createAgent(true);
    const inFlight = prepareRfc64LateLegacySwmBoundaryV1(agent, CONTEXT_GRAPH_ID, UAL_A, 'in-flight-share', '1');
    const retirement = retireRfc64LegacySwmAfterFinalizedVmV1(agent, CONTEXT_GRAPH_ID, UAL_A, '1');

    const refusal = thrownBy(() => materializationCompanion(UAL_B, 'update-of-b'));
    expect(refusal.message).toContain('retirement is in progress; retry promotion');
    expect(refusal.code).not.toBe('PROMOTE_RETRYABLE_FAILURE');

    inFlight.settle(false);
    await retirement;
  });

  it('does not make a hard refusal retryable: unavailable boundary persistence stays plain', async () => {
    const { promoteCompanion } = await createAgent(false);

    const refusal = thrownBy(() => promoteCompanion(UAL_B, 'share-of-b'));
    expect(refusal.message).toContain('boundary persistence is unavailable');
    expect(refusal.code).toBeUndefined();
    expect(getPromoteFailureDisposition(refusal)).toBeUndefined();
  });
});

describe('translateLegacySwmRetirementFence', () => {
  const fenceError = () => Object.assign(new Error(FENCE_MESSAGE), { code: FENCE_CODE });

  it('wraps only the fence, keeping the original refusal as the cause', () => {
    const original = fenceError();
    const refusal = thrownBy(() => precommit.translateLegacySwmRetirementFence(() => { throw original; }));
    expect(refusal.code).toBe('PROMOTE_RETRYABLE_FAILURE');
    expect(refusal.cause).toBe(original);
    expect(boundary.isRfc64LegacySwmBoundaryRetirementInProgressV1(original)).toBe(true);
  });

  it('returns what the prepare returns', () => {
    const companion = { graphUri: 'urn:test:companion' };
    expect(precommit.translateLegacySwmRetirementFence(() => companion)).toBe(companion);
  });

  it.each([
    ['a plain refusal with the same words', new Error(FENCE_MESSAGE)],
    ['another coded refusal', Object.assign(new Error('x'), { code: 'SOMETHING_ELSE' })],
    ['a non-error value', 'retirement is in progress'],
    ['an object whose code getter throws', new Proxy({}, { get() { throw new Error('hostile getter'); } })],
  ])('passes %s through untouched', (_name, thrown) => {
    let seen: unknown;
    try {
      precommit.translateLegacySwmRetirementFence(() => { throw thrown; });
    } catch (error) {
      seen = error;
    }
    expect(seen).toBe(thrown);
    expect(boundary.isRfc64LegacySwmBoundaryRetirementInProgressV1(thrown)).toBe(false);
  });
});
