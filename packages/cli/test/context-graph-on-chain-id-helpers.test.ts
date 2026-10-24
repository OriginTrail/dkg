/**
 * The daemon helpers behind on-chain Context Graph ids (`32`, `#32`), driven
 * with stand-in agents: who may follow an id to a row, catch-up status
 * lookup, and the start-up mapping when the resolver fails or is missing.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { latestCatchupJobIdFor } from '../src/daemon/routes/query.js';
import { resolveConfiguredOnChainContextGraphIds } from '../src/daemon/lifecycle.js';
import { mayFollowOnChainIdToRow } from '../src/daemon/context-graph-on-chain-id-gate.js';

const CLEARTEXT = 'gnosis-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const OPERATOR = { isNodeAdmin: true, agentAddress: undefined };
const MEMBER = { isNodeAdmin: false, agentAddress: '0x00000000000000000000000000000000000000aa' };
const OUTSIDER = { isNodeAdmin: false, agentAddress: '0x00000000000000000000000000000000000000bb' };

/** An agent whose read authority admits MEMBER only. */
function authorityAgent(extra: Record<string, unknown> = {}) {
  const authority = vi.fn(async (_contextGraphId: string, options: { callerAgentAddress?: string }) => ({
    outcome: options.callerAgentAddress === MEMBER.agentAddress ? 'allowed' : 'denied',
  }));
  return {
    agent: {
      resolveContextGraphSubscriptionBootstrapAuthority: authority,
      getDefaultAgentAddress: () => '0x00000000000000000000000000000000000000dd',
      ...extra,
    } as unknown as DKGAgent,
    authority,
  };
}

describe('following an on-chain id to a row', () => {
  it('follows to a name-hash row for anyone, without an authority read', async () => {
    const { agent, authority } = authorityAgent();
    await expect(mayFollowOnChainIdToRow(agent, { contextGraphId: NAME_HASH, nameHash: NAME_HASH }, OUTSIDER))
      .resolves.toBe(true);
    expect(authority).not.toHaveBeenCalled();
  });

  it('follows to a cleartext row only for the operator or an admitted agent', async () => {
    const { agent, authority } = authorityAgent();
    const row = { contextGraphId: CLEARTEXT, nameHash: NAME_HASH };
    await expect(mayFollowOnChainIdToRow(agent, row, OPERATOR)).resolves.toBe(true);
    expect(authority).not.toHaveBeenCalled();
    await expect(mayFollowOnChainIdToRow(agent, row, MEMBER)).resolves.toBe(true);
    await expect(mayFollowOnChainIdToRow(agent, row, OUTSIDER)).resolves.toBe(false);
    // A caller without an agent is checked as the node's default agent.
    await expect(mayFollowOnChainIdToRow(agent, row, { isNodeAdmin: false, agentAddress: undefined }))
      .resolves.toBe(false);
    expect(authority).toHaveBeenLastCalledWith(CLEARTEXT, {
      callerAgentAddress: '0x00000000000000000000000000000000000000dd',
      allowSubscriptionFallback: false,
    });
  });

  it('does not follow when the authority read fails', async () => {
    const agent = {
      resolveContextGraphSubscriptionBootstrapAuthority: async () => { throw new Error('rpc down'); },
      getDefaultAgentAddress: () => undefined,
    } as unknown as DKGAgent;
    await expect(mayFollowOnChainIdToRow(agent, { contextGraphId: CLEARTEXT, nameHash: NAME_HASH }, MEMBER))
      .resolves.toBe(false);
  });
});

describe('catch-up status by on-chain id', () => {
  const tracker = (entries: Record<string, string>) => ({
    jobs: new Map(),
    latestByContextGraph: new Map(Object.entries(entries)),
  });
  /** An agent whose lookup finds `row` for on-chain id 32 and nothing else. */
  const agentKnowing = (row: { contextGraphId: string; nameHash: string } | null) => authorityAgent({
    lookupContextGraphOnChainIdReference: (reference: string) => {
      if (reference !== '32' && reference !== '#32') return { kind: 'as-given' };
      return row === null ? { kind: 'not-held', onChainId: '32' } : { kind: 'held', onChainId: '32', ...row };
    },
  }).agent;

  it('finds the job of the graph the id names, under its cleartext id or its name hash', async () => {
    const cleartextRow = agentKnowing({ contextGraphId: CLEARTEXT, nameHash: NAME_HASH });
    await expect(latestCatchupJobIdFor(cleartextRow, tracker({ [CLEARTEXT]: 'job-a' }), '#32', OPERATOR))
      .resolves.toBe('job-a');
    // Adopted after the job ran: the job is still keyed by the name hash.
    await expect(latestCatchupJobIdFor(cleartextRow, tracker({ [NAME_HASH]: 'job-b' }), '32', OPERATOR))
      .resolves.toBe('job-b');
    await expect(latestCatchupJobIdFor(cleartextRow, tracker({}), '#32', OPERATOR)).resolves.toBeUndefined();
    await expect(latestCatchupJobIdFor(agentKnowing(null), tracker({ [NAME_HASH]: 'job-b' }), '#32', OPERATOR))
      .resolves.toBeUndefined();
    await expect(latestCatchupJobIdFor(cleartextRow, tracker({}), 'acme', OPERATOR)).resolves.toBeUndefined();
  });

  it('shows a cleartext row\'s job only to a caller who may follow the id there', async () => {
    const cleartextRow = agentKnowing({ contextGraphId: CLEARTEXT, nameHash: NAME_HASH });
    const jobs = tracker({ [NAME_HASH]: 'job-b' });
    await expect(latestCatchupJobIdFor(cleartextRow, jobs, '#32', MEMBER)).resolves.toBe('job-b');
    await expect(latestCatchupJobIdFor(cleartextRow, jobs, '#32', OUTSIDER)).resolves.toBeUndefined();
    // A name-hash row's job reveals nothing the chain does not.
    const hashRow = agentKnowing({ contextGraphId: NAME_HASH, nameHash: NAME_HASH });
    await expect(latestCatchupJobIdFor(hashRow, jobs, '#32', OUTSIDER)).resolves.toBe('job-b');
  });

  it('lets a job keyed by the literal id win', async () => {
    const agent = agentKnowing({ contextGraphId: NAME_HASH, nameHash: NAME_HASH });
    const jobs = tracker({ 32: 'job-literal', [NAME_HASH]: 'job-graph' });
    await expect(latestCatchupJobIdFor(agent, jobs, '32', OUTSIDER)).resolves.toBe('job-literal');
    await expect(latestCatchupJobIdFor(agent, jobs, '#32', OUTSIDER)).resolves.toBe('job-graph');
  });
});

describe('configured on-chain ids when the resolver fails', () => {
  it('fails closed for an id whose resolution throws, and leaves the others alone', async () => {
    // The resolver reports its own failures, so a throw is a defect.
    const resolve = vi.fn(async (reference: string) => {
      if (reference === '32') throw new Error('boom');
      return { kind: 'as-given' };
    });
    const agent = {
      getSubscribedContextGraphs: () => new Map(),
      resolveContextGraphOnChainIdReference: resolve,
    } as unknown as DKGAgent;
    const log: string[] = [];
    await expect(resolveConfiguredOnChainContextGraphIds(agent, ['32', 'acme'], (line) => log.push(line)))
      .resolves.toEqual(['acme']);
    expect(log).toEqual(['Context graph "32" could not be resolved (boom) — not subscribing it']);
    expect(resolve).toHaveBeenCalledTimes(2);

    // An agent without the resolver (an older build) keeps the ids as given.
    await expect(resolveConfiguredOnChainContextGraphIds({} as DKGAgent, ['32'], () => {})).resolves.toEqual(['32']);
  });
});
