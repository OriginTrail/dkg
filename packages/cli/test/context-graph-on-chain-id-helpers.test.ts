/**
 * The daemon helpers behind on-chain Context Graph ids (`32`, `#32`), driven
 * with stand-in agents: catch-up status lookup, and the start-up mapping when
 * the resolver itself fails or is missing.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { latestCatchupJobIdFor } from '../src/daemon/routes/query.js';
import { resolveConfiguredOnChainContextGraphIds } from '../src/daemon/lifecycle.js';

const CLEARTEXT = 'gnosis-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();

describe('catch-up status by on-chain id', () => {
  const tracker = (entries: Record<string, string>) => ({
    jobs: new Map(),
    latestByContextGraph: new Map(Object.entries(entries)),
  });
  const agentKnowing = (row: { contextGraphId: string; nameHash: string } | null) => ({
    localContextGraphIdForOnChainId: (onChainId: string) => (onChainId === '32' ? row : null),
  }) as unknown as DKGAgent;

  it('finds the job of the graph the id names, under its cleartext id or its name hash', () => {
    const cleartextRow = agentKnowing({ contextGraphId: CLEARTEXT, nameHash: NAME_HASH });
    expect(latestCatchupJobIdFor(cleartextRow, tracker({ [CLEARTEXT]: 'job-a' }), '#32')).toBe('job-a');
    // Adopted after the job ran: the job is still keyed by the name hash.
    expect(latestCatchupJobIdFor(cleartextRow, tracker({ [NAME_HASH]: 'job-b' }), '32')).toBe('job-b');
    expect(latestCatchupJobIdFor(cleartextRow, tracker({}), '#32')).toBeUndefined();
    expect(latestCatchupJobIdFor(agentKnowing(null), tracker({ [NAME_HASH]: 'job-b' }), '#32')).toBeUndefined();
    expect(latestCatchupJobIdFor(cleartextRow, tracker({}), 'acme')).toBeUndefined();
  });

  it('lets a job keyed by the literal id win', () => {
    const agent = agentKnowing({ contextGraphId: NAME_HASH, nameHash: NAME_HASH });
    const jobs = tracker({ 32: 'job-literal', [NAME_HASH]: 'job-graph' });
    expect(latestCatchupJobIdFor(agent, jobs, '32')).toBe('job-literal');
    expect(latestCatchupJobIdFor(agent, jobs, '#32')).toBe('job-graph');
  });
});

describe('configured on-chain ids when the resolver fails', () => {
  it('never lets a resolver failure subscribe the number, and leaves other ids alone', async () => {
    const resolve = vi.fn(async () => { throw new Error('boom'); });
    const agent = {
      getSubscribedContextGraphs: () => new Map(),
      resolveContextGraphOnChainIdReference: resolve,
    } as unknown as DKGAgent;
    const log: string[] = [];
    await expect(resolveConfiguredOnChainContextGraphIds(agent, ['32', 'acme'], (line) => log.push(line)))
      .resolves.toEqual(['acme']);
    expect(log).toEqual(['Context graph "32" could not be resolved as an on-chain id (boom) — not subscribing it']);
    expect(resolve).toHaveBeenCalledTimes(1);

    // An agent without the resolver (an older build) keeps the ids as given.
    await expect(resolveConfiguredOnChainContextGraphIds({} as DKGAgent, ['32'], () => {})).resolves.toEqual(['32']);
  });
});
