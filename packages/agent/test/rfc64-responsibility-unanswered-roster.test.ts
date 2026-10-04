/**
 * Catalog responsibility for a private graph follows this node's membership,
 * read from the graph's roster. When the chain read behind the roster gets no
 * answer (the node's own RPC budget did not admit it, or the endpoint did not
 * reply in time) the pass learns nothing about the graph: a responsibility
 * this node holds as a member stays, and the graph is asked again shortly.
 *
 * These run the production responsibility pass, membership check and roster
 * resolution on a started agent. Only the registered-authority read is
 * scripted, and the graph's local metadata is taken as confirmed.
 */
import type { ContextGraphAuthorityIndexId } from '@origintrail-official/dkg-chain';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import type { EvmAddressV1 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import {
  unansweredAuthorityRecheckFor,
  type UnansweredAuthorityRecheck,
} from '../src/internal/unanswered-authority-recheck.js';
import type { RegisteredContextGraphAuthority } from '../src/registered-context-graph-authority.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_AUTHOR as AUTHOR,
} from './_helpers/rfc64-rollout-agent-harness.js';

const MEMBER = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const ON_CHAIN_ID = '9';
/** Short, so a repeat the wait starts is seen without slowing the suite. */
const RECHECK_MS = 25;

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

type RegisteredAuthorityRead = () => RegisteredContextGraphAuthority;
const roster = (...participantAgents: string[]): RegisteredAuthorityRead => () => ({
  kind: 'private', onChainId: BigInt(ON_CHAIN_ID), participantAgents,
});
/** What the registered-authority read gives when its chain read ran out of time. */
const noAnswer: RegisteredAuthorityRead = () => ({
  kind: 'unavailable', reason: 'chain-access-policy-timeout', onChainId: BigInt(ON_CHAIN_ID),
});

/**
 * A subscribed, bound private graph on an edge that holds the member's
 * identity. Each registered-authority read takes the next entry of `script`,
 * and the last one repeats.
 */
async function memberEdge(name: string, script: readonly RegisteredAuthorityRead[]) {
  const contextGraphId = `${AUTHOR}/${name}`;
  const snapshot = Object.freeze({
    chainId: '20430',
    governanceContract: '0x3333333333333333333333333333333333333333',
    contextGraphId: ON_CHAIN_ID,
    owner: AUTHOR,
    active: true,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: AUTHOR,
    publishAuthorityAccountId: '0',
    participantAgents: Object.freeze([AUTHOR, MEMBER]),
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
    ownershipEra: '0',
    policyVersion: '0',
    rosterVersion: '0',
    sourceBlockNumber: '42',
    sourceBlockHash: `0x${'44'.repeat(32)}`,
  });
  const chainAdapter = Object.assign(new NoChainAdapter(), {
    contextGraphAuthorityIndexRevisionReader: {
      readContextGraphAuthorityIndexSnapshots: async (
        ids: readonly ContextGraphAuthorityIndexId[],
      ) => new Map(ids.map((id) => [id, snapshot])),
      readContextGraphAuthorityIndexRevisions: async () => new Map(),
      whenIdle: async () => undefined,
    },
  });
  const edge = await startAgent({
    name,
    config: {
      chainAdapter,
      rfc64CatalogAccessPolicyAuthority: {
        localAgentAddress: MEMBER,
        resolveRemoteAgentAddress: async () => null,
      },
    },
  });
  // The one cast exposes private host seams. The responsibility pass, the
  // membership check and the roster behind it stay production code.
  const internals = edge as any;
  internals.defaultAgentAddress = MEMBER;
  vi.spyOn(edge, 'getExplicitAccessPolicy').mockResolvedValue(null);
  vi.spyOn(internals, 'hasConfirmedMetaState').mockResolvedValue(true);
  // What an active responsibility goes on to do is not under test here.
  vi.spyOn(edge, 'reconcileRfc64CatalogAccessAuthorityV1').mockResolvedValue(null as never);
  vi.spyOn(internals.rfc64PublicCatalogOwnerV1, 'requestAuthorityRefresh').mockReturnValue(undefined);

  const rosterReads = vi.spyOn(internals, 'resolveSwmRegisteredAuthority');
  let next = 0;
  rosterReads.mockImplementation(async () => script[Math.min(next++, script.length - 1)]!());

  const recheck: UnansweredAuthorityRecheck = unansweredAuthorityRecheckFor(
    edge,
    internals.rfc64BackgroundWorkDispatcherV1.shutdownSignal,
    RECHECK_MS,
  );
  const spies = {
    info: vi.spyOn(internals.log, 'info'),
    debug: vi.spyOn(internals.log, 'debug'),
  };
  const logged = (level: keyof typeof spies): string[] => spies[level].mock.calls
    .map(([, message]) => String(message))
    .filter((message) => message.startsWith('RFC-64 catalog responsibility for'));
  const responsibility = () => edge.readRfc64CatalogResponsibilitiesV1()
    .find((selection) => selection.contextGraphId === contextGraphId);

  edge.subscribeToContextGraph(contextGraphId);
  await edge.whenRfc64CatalogResponsibilitiesIdleV1();
  internals.bindSubscriptionOnChainId(
    contextGraphId,
    edge.getSubscribedContextGraphs().get(contextGraphId),
    ON_CHAIN_ID,
  );
  await edge.whenRfc64CatalogResponsibilitiesIdleV1();
  return { edge: edge as DKGAgent, contextGraphId, rosterReads, recheck, logged, responsibility };
}

const waitingLine = (contextGraphId: string, meanwhile: string): string => (
  `RFC-64 catalog responsibility for "${contextGraphId}" is waiting for the member roster `
  + '(registered-authority/chain-access-policy-timeout/chain): the chain read got no answer; '
  + `${meanwhile}, asking again shortly`
);

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('catalog responsibility whose roster read gets no answer', () => {
  it('keeps a responsibility this node holds as a member and asks again on its own', async () => {
    const host = await memberEdge('kept', [roster(AUTHOR, MEMBER), noAnswer, roster(AUTHOR, MEMBER)]);
    const { edge, contextGraphId, rosterReads, recheck, logged } = host;
    expect(host.responsibility()).toMatchObject({
      active: true, responsibilityReason: 'private-membership',
    });
    expect(rosterReads).toHaveBeenCalledTimes(1);

    // What a share, a subscription or a registration does.
    await expect(edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId))
      .resolves.toMatchObject({ active: true, responsibilityReason: 'private-membership' });
    expect(rosterReads).toHaveBeenCalledTimes(2);
    expect(host.responsibility()).toMatchObject({
      active: true, responsibilityReason: 'private-membership',
    });
    expect(recheck.size).toBe(1);
    expect(logged('info')).toEqual([waitingLine(contextGraphId, 'the responsibility is kept')]);

    // No event reconciled the graph from outside.
    await expect.poll(() => rosterReads.mock.calls.length).toBe(3);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(host.responsibility()).toMatchObject({
      active: true, responsibilityReason: 'private-membership',
    });
    // The roster answered: the graph no longer waits and is not asked again.
    expect(recheck.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 4 * RECHECK_MS));
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(rosterReads).toHaveBeenCalledTimes(3);
  });

  it('withdraws the responsibility once the roster answers without this member', async () => {
    const host = await memberEdge('withdrawn-later', [roster(AUTHOR, MEMBER), noAnswer, roster(AUTHOR)]);
    const { edge, contextGraphId, rosterReads, recheck } = host;

    await edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    expect(host.responsibility()).toMatchObject({ active: true });

    await expect.poll(() => rosterReads.mock.calls.length).toBe(3);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(host.responsibility()).toBeUndefined();
    expect(recheck.size).toBe(0);
  });

  it('withdraws at once when the roster answers without this member', async () => {
    const host = await memberEdge('withdrawn', [roster(AUTHOR, MEMBER), roster(AUTHOR)]);
    const { edge, contextGraphId, recheck, logged } = host;

    await expect(edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId))
      .resolves.toMatchObject({ active: false, responsibilityReason: null });
    expect(host.responsibility()).toBeUndefined();
    expect(recheck.size).toBe(0);
    expect(logged('info')).toEqual([]);
  });

  it('takes the responsibility once the roster answers, without waiting for another event', async () => {
    const host = await memberEdge('taken-later', [noAnswer, roster(AUTHOR, MEMBER)]);
    const { edge, contextGraphId, rosterReads, recheck, logged } = host;

    // The subscription's own pass got no answer: unanswered is not a "yes".
    expect(logged('info')).toEqual([waitingLine(contextGraphId, 'not responsible yet')]);

    await expect.poll(() => rosterReads.mock.calls.length).toBe(2);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(host.responsibility()).toMatchObject({
      active: true, responsibilityReason: 'private-membership',
    });
    expect(recheck.size).toBe(0);
  });

  it('does not ask again a graph that an event reconciled in the meantime', async () => {
    const host = await memberEdge('settled', [roster(AUTHOR, MEMBER), noAnswer, roster(AUTHOR, MEMBER)]);
    const { edge, contextGraphId, rosterReads, recheck } = host;

    await edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    expect(recheck.size).toBe(1);

    // An event reconciles the graph before its turn, and the roster answers.
    await edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    expect(rosterReads).toHaveBeenCalledTimes(3);
    expect(recheck.size).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 4 * RECHECK_MS));
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(rosterReads).toHaveBeenCalledTimes(3);
  });

  it('keeps the responsibility when the read that confirms an unregistered graph gets no answer', async () => {
    const host = await memberEdge('second-read', [
      roster(AUTHOR, MEMBER), () => ({ kind: 'unregistered' }), noAnswer, roster(AUTHOR, MEMBER),
    ]);
    const { edge, contextGraphId, rosterReads, recheck } = host;

    await expect(edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId))
      .resolves.toMatchObject({ active: true, responsibilityReason: 'private-membership' });
    // The roster source read the registration, then read it again after the
    // local metadata; the second read is the one that got no answer.
    expect(rosterReads).toHaveBeenCalledTimes(3);
    expect(recheck.size).toBe(1);
  });

  it('asks nothing again when the roster cannot change the outcome', async () => {
    const host = await memberEdge('no-difference', [roster(AUTHOR, MEMBER), noAnswer]);
    const { edge, contextGraphId, rosterReads, recheck, logged } = host;
    const internals = edge as any;
    // A private graph this node holds as a host is in no member's
    // responsibility set, whatever its roster says.
    internals.subscribedContextGraphs.set(contextGraphId, {
      ...internals.subscribedContextGraphs.get(contextGraphId),
      coreHosted: true,
    });

    await expect(edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId))
      .resolves.toMatchObject({ active: false, responsibilityReason: null });
    expect(rosterReads).toHaveBeenCalledTimes(2);
    expect(host.responsibility()).toBeUndefined();
    expect(recheck.size).toBe(0);
    expect(logged('info')).toEqual([]);
  });

  it('keeps asking for as long as there is no answer, and says so once', async () => {
    const host = await memberEdge('asked-again', [
      roster(AUTHOR, MEMBER), noAnswer, noAnswer, noAnswer, roster(AUTHOR, MEMBER),
    ]);
    const { edge, contextGraphId, rosterReads, recheck, logged } = host;

    await edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    await expect.poll(() => rosterReads.mock.calls.length).toBe(5);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(host.responsibility()).toMatchObject({ active: true });
    expect(recheck.size).toBe(0);
    // Said once where an operator sees it; the repeats stay at debug level.
    expect(logged('info')).toEqual([waitingLine(contextGraphId, 'the responsibility is kept')]);
    expect(logged('debug')).toEqual([
      waitingLine(contextGraphId, 'the responsibility is kept'),
      waitingLine(contextGraphId, 'the responsibility is kept'),
    ]);
  });

  it('does not keep a responsibility held for another reason', async () => {
    const host = await memberEdge('other-reason', [noAnswer]);
    const { edge, contextGraphId, recheck } = host;
    const internals = edge as any;
    // The responsibility an edge holds for a public graph it subscribes to.
    internals.commitRfc64CatalogResponsibilityV1(contextGraphId, 'edge-subscription');
    expect(host.responsibility()).toMatchObject({ responsibilityReason: 'edge-subscription' });

    // The graph is private and its roster does not answer: neither answer
    // would leave this node responsible as a public subscriber.
    await expect(edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId))
      .resolves.toMatchObject({ active: false, responsibilityReason: null });
    expect(host.responsibility()).toBeUndefined();
    // The roster can still make this node responsible as a member.
    expect(recheck.size).toBe(1);
  });

  it('asks nothing after the agent has stopped', async () => {
    const host = await memberEdge('stopped', [roster(AUTHOR, MEMBER), noAnswer]);
    const { edge, contextGraphId, rosterReads, recheck } = host;

    await edge.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    expect(recheck.size).toBe(1);

    await edge.stop();
    expect(recheck.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 4 * RECHECK_MS));
    expect(rosterReads).toHaveBeenCalledTimes(2);
  });
});
