import { describe, expect, it, vi } from 'vitest';
import { reconcilePublisherCandidateFunding, type PublisherFundingSelection, type PublisherPcaPricingEvidence } from '../src/evm-publisher-funding.js';
import { InsufficientPublisherFundsError, PcaFundingUnknownError } from '../src/evm-adapter-errors.js';

type Candidate = { address: string; publishEpochs: number; tokenAmount: bigint; pcaPricing: PublisherPcaPricingEvidence };

describe('EVM publish funding candidate ownership', () => {
  it('assesses explicit repriced snapshots without changing the caller array, with sequential repricing', async () => {
    const pricing: PublisherPcaPricingEvidence = { kind: 'unavailable', error: new Error('pricing temporarily unavailable') };
    const candidates: readonly Candidate[] = Object.freeze([
      Object.freeze({ address: 'first', publishEpochs: 12, tokenAmount: 120n, pcaPricing: pricing }),
      Object.freeze({ address: 'second', publishEpochs: 12, tokenAmount: 120n, pcaPricing: pricing }),
    ]);
    const observed: Array<readonly Candidate[]> = [];
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const firstReprice = new Promise<void>((resolve) => { entered = resolve; });
    const error = new InsufficientPublisherFundsError('not yet funded', []);
    const assess = vi.fn(async (current: readonly Candidate[] = candidates): Promise<PublisherFundingSelection<Candidate>> => {
      observed.push(current);
      if (observed.length === 1) return { kind: 'unfunded', assessments: current.map((candidate) => ({
        kind: 'unfunded' as const, candidate, funding: { native: 10n, trac: 0n },
        refreshPcaEligibility: async () => true,
      })), error };
      expect(current.map((candidate) => candidate.tokenAmount)).toEqual([240n, 240n]);
      return { kind: 'funded', candidate: current[1] };
    });
    const pending = reconcilePublisherCandidateFunding({
      candidates,
      assess,
      reprice: async (candidate) => {
        order.push(`${candidate.address}:start`);
        if (candidate.address === 'first') { entered(); await hold; }
        order.push(`${candidate.address}:end`);
        return { ...candidate, tokenAmount: 240n, publishEpochs: 24, pcaPricing: { kind: 'available' as const } };
      },
      conviction: () => undefined,
    });
    await firstReprice;
    expect(order).toEqual(['first:start']);
    expect(assess).toHaveBeenCalledTimes(1);
    release();
    await expect(pending).resolves.toMatchObject({ address: 'second', tokenAmount: 240n, publishEpochs: 24 });
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(candidates);
    expect(observed[1]).not.toBe(candidates);
    expect(observed[1]).not.toBe(observed[0]);
    expect(observed[0].map((candidate) => candidate.tokenAmount)).toEqual([120n, 120n]);
    expect(candidates.map((candidate) => candidate.tokenAmount)).toEqual([120n, 120n]);
  });

  it('consumes assessment-owned fresh eligibility without independent funding policy', async () => {
    const candidate: Candidate = { address: 'wallet', publishEpochs: 12, tokenAmount: 120n,
      pcaPricing: { kind: 'unavailable', error: new Error('pricing read failed') } };
    const repriced = { ...candidate, publishEpochs: 24, tokenAmount: 240n, pcaPricing: { kind: 'available' as const } };
    const refreshPcaEligibility = vi.fn(async () => true);
    const error = new InsufficientPublisherFundsError('not funded at fallback lifetime', []);
    const reprice = vi.fn(async () => repriced);
    let calls = 0;
    await expect(reconcilePublisherCandidateFunding({
      candidates: [candidate],
      assess: async (): Promise<PublisherFundingSelection<Candidate>> => ++calls === 1
        ? { kind: 'unfunded', assessments: [{ kind: 'unfunded', candidate, funding: { native: 10n, trac: 0n }, refreshPcaEligibility }], error }
        : { kind: 'funded', candidate: repriced },
      reprice, conviction: () => undefined,
    })).resolves.toBe(repriced);
    expect(refreshPcaEligibility).toHaveBeenCalledTimes(1);
    expect(reprice).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it('propagates the assessed unknown error without repricing or extra funding reads', async () => {
    const candidate = { address: 'wallet', publishEpochs: 12, tokenAmount: 120n, pcaPricing: { kind: 'available' as const } };
    const error = new PcaFundingUnknownError('CALL_EXCEPTION');
    const reprice = vi.fn();
    await expect(reconcilePublisherCandidateFunding({
      candidates: [candidate], assess: async () => ({ kind: 'unavailable', assessments: [], error }),
      reprice, conviction: () => undefined,
    })).rejects.toBe(error);
    expect(reprice).not.toHaveBeenCalled();
  });
});
