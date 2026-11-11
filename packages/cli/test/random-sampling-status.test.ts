import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient, type RandomSamplingStatusResponse } from '../src/api-client.js';
import { registerRandomSamplingCommand } from '../src/commands/random-sampling.js';
import { describeRandomSamplingDisabledStatus } from '../src/random-sampling-status.js';

describe('Random Sampling disabled status', () => {
  it('explains a prover whose physical cleanup is still pending', () => {
    expect(describeRandomSamplingDisabledStatus({ role: 'core', identityId: '52', disabledReason: 'not_started', retiring: true }))
      .toBe('prover disabled; waiting for physical resource cleanup');
  });

  it('distinguishes a profiled core awaiting admission from a missing identity', () => {
    expect(describeRandomSamplingDisabledStatus({
      role: 'core',
      identityId: '17',
      disabledReason: 'awaiting_sharding_table',
    })).toBe('profile exists; waiting for sharding-table admission');

    expect(describeRandomSamplingDisabledStatus({
      role: 'core',
      identityId: '0',
      disabledReason: 'no_identity',
    })).toBe('no on-chain identity yet (complete profile registration and staking)');
  });

  it('keeps edge-node and older-daemon responses understandable', () => {
    expect(describeRandomSamplingDisabledStatus({
      role: 'edge',
      identityId: '0',
      disabledReason: 'edge_node',
    })).toBe('edge node — random sampling is core-only');

    expect(describeRandomSamplingDisabledStatus({
      role: 'core',
      identityId: '23',
    })).toBe('prover unavailable; inspect daemon logs');
  });
});

describe('dkg random-sampling status output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Loop fields every daemon version reports. */
  const baseLoop = {
    totalTicks: 8,
    inflight: false,
    lastTickAt: '2026-09-15T10:00:00.000Z',
    lastOutcome: { kind: 'kc-not-synced' },
    submittedCount: 3,
    lastSubmittedAt: null,
    lastSubmittedTxHash: null,
  };

  async function renderStatus(loop: RandomSamplingStatusResponse['loop']): Promise<string> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      randomSamplingStatus: async () => ({ enabled: true, role: 'core', identityId: '42', loop }),
    } as any);

    const program = new Command();
    program.exitOverride();
    registerRandomSamplingCommand(program);
    await program.parseAsync(['node', 'dkg', 'random-sampling', 'status']);
    return logs.join('\n');
  }

  it('renders rolling challenge/proof health and the latest failure', async () => {
    const output = await renderStatus({
      ...baseLoop,
      challengesReceived24h: 2,
      proofsSubmitted24h: 1,
      lastFailureClassification: 'kc-not-synced',
      lastFailureAt: '2026-09-15T09:59:00.000Z',
    });
    expect(output).toContain('24h health: 2 challenges, 1 proof submitted');
    expect(output).toContain('Last failure: kc-not-synced (2026-09-15T09:59:00.000Z)');
  });

  it('renders n/a, not 0, when an older daemon omits the health fields', async () => {
    const output = await renderStatus(baseLoop);
    expect(output).toContain('24h health: n/a challenges, n/a proofs submitted');
    expect(output).not.toContain('Last failure:');
  });

  it('keeps a reported zero distinct from a missing counter', async () => {
    const output = await renderStatus({
      ...baseLoop,
      challengesReceived24h: 0,
      proofsSubmitted24h: 0,
      lastFailureClassification: null,
      lastFailureAt: null,
    });
    expect(output).toContain('24h health: 0 challenges, 0 proofs submitted');
    expect(output).not.toContain('Last failure:');
  });
});
