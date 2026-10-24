import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { FinalizationHandler, type ResolveContextGraphOnChainId } from '../src/finalization-handler.js';

/**
 * Which on-chain context graph id a finalization is materialized under.
 *
 * The envelope's own `targetContextGraphId` wins. When it is omitted the
 * handler asks the chain by KA id first: that binding is authoritative and
 * immune to the local ontology-binding lag that strands KAs in the label
 * `_meta` graph, where the random-sampling prover does not look. Only then
 * come the local topic id and the injected resolver.
 *
 * The chain answer is cached positive-only. A finalization that races ahead
 * of its on-chain KA-to-context-graph binding must ask again next time, not
 * stay pinned to a local fallback.
 */

const CONTEXT_GRAPH = 'cg-id-resolution';
const KA_ID = 7n;

type ChainArg = ConstructorParameters<typeof FinalizationHandler>[1];

/** Chain stub answering `getKAContextGraphId` from a scripted sequence. */
function chainStub(sequence: Array<bigint | null | Error>): { chain: ChainArg; calls: bigint[] } {
  const calls: bigint[] = [];
  let next = 0;
  const stub = {
    chainId: 'hardhat',
    getKAContextGraphId: async (kaId: bigint) => {
      calls.push(kaId);
      const answer = sequence[Math.min(next, sequence.length - 1)];
      next += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { chain: stub as unknown as ChainArg, calls };
}

function recordingResolver(
  answer: (contextGraphId: string) => Promise<string | null | undefined>,
): ResolveContextGraphOnChainId & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(async (contextGraphId: string) => {
    calls.push(contextGraphId);
    return answer(contextGraphId);
  }, { calls });
}

function resolve(
  handler: FinalizationHandler,
  options: { target?: string; kaId?: bigint; localTopicId?: string } = {},
): Promise<string | undefined> {
  return (handler as unknown as {
    resolveFinalizationContextGraphId(
      contextGraphId: string,
      targetContextGraphId: string | undefined,
      chainLookupId: bigint,
      ctx: ReturnType<typeof createOperationContext>,
      localTopicOnChainContextGraphId?: string,
    ): Promise<string | undefined>;
  }).resolveFinalizationContextGraphId(
    CONTEXT_GRAPH,
    options.target,
    options.kaId ?? KA_ID,
    createOperationContext('gossip'),
    options.localTopicId,
  );
}

describe('finalization context graph id resolution', () => {
  it('uses the envelope target without asking the chain or the resolver', async () => {
    const { chain, calls } = chainStub([5n]);
    const resolver = recordingResolver(async () => '99');
    const handler = new FinalizationHandler(new OxigraphStore(), chain, {
      resolveContextGraphOnChainId: resolver,
    });

    await expect(resolve(handler, { target: '42', localTopicId: '77' })).resolves.toBe('42');
    expect(calls).toEqual([]);
    expect(resolver.calls).toEqual([]);
  });

  it('asks the chain by KA id when the envelope omits the target', async () => {
    const { chain, calls } = chainStub([5n]);
    const resolver = recordingResolver(async () => '99');
    const handler = new FinalizationHandler(new OxigraphStore(), chain, {
      resolveContextGraphOnChainId: resolver,
    });

    await expect(resolve(handler, { localTopicId: '77' })).resolves.toBe('5');
    expect(calls).toEqual([KA_ID]);
    expect(resolver.calls).toEqual([]);
  });

  it('does not cache a miss, and caches a positive answer', async () => {
    const { chain, calls } = chainStub([0n, 5n]);
    const handler = new FinalizationHandler(new OxigraphStore(), chain);

    // The binding has not landed yet: nothing resolves and nothing is cached.
    await expect(resolve(handler)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);

    // Asked again, the chain now answers.
    await expect(resolve(handler)).resolves.toBe('5');
    expect(calls).toHaveLength(2);

    // The positive answer is cached: no third chain read.
    await expect(resolve(handler)).resolves.toBe('5');
    expect(calls).toHaveLength(2);
  });

  it('falls back to the local topic id when the chain has no binding', async () => {
    const { chain, calls } = chainStub([null]);
    const resolver = recordingResolver(async () => '99');
    const handler = new FinalizationHandler(new OxigraphStore(), chain, {
      resolveContextGraphOnChainId: resolver,
    });

    await expect(resolve(handler, { localTopicId: '77' })).resolves.toBe('77');
    expect(calls).toEqual([KA_ID]);
    expect(resolver.calls).toEqual([]);
  });

  it('falls back to the resolver when the chain read fails', async () => {
    const { chain, calls } = chainStub([new Error('RPC lag')]);
    const resolver = recordingResolver(async () => '99');
    const handler = new FinalizationHandler(new OxigraphStore(), chain, {
      resolveContextGraphOnChainId: resolver,
    });

    await expect(resolve(handler)).resolves.toBe('99');
    expect(calls).toEqual([KA_ID]);
    expect(resolver.calls).toEqual([CONTEXT_GRAPH]);
  });

  it('goes straight to the resolver when there is no chain or no KA id to look up', async () => {
    const resolver = recordingResolver(async () => '99');
    const withoutChain = new FinalizationHandler(new OxigraphStore(), undefined, {
      resolveContextGraphOnChainId: resolver,
    });
    await expect(resolve(withoutChain)).resolves.toBe('99');

    const { chain, calls } = chainStub([5n]);
    const withoutLookupId = new FinalizationHandler(new OxigraphStore(), chain, {
      resolveContextGraphOnChainId: resolver,
    });
    await expect(resolve(withoutLookupId, { kaId: 0n })).resolves.toBe('99');
    expect(calls).toEqual([]);
    expect(resolver.calls).toEqual([CONTEXT_GRAPH, CONTEXT_GRAPH]);
  });

  it.each([
    ['no resolver is wired', undefined],
    ['the resolver answers null', recordingResolver(async () => null)],
    ['the resolver answers an empty id', recordingResolver(async () => '')],
    ['the resolver throws', recordingResolver(async () => { throw new Error('ontology not ready'); })],
  ])('resolves nothing when %s', async (_name, resolver) => {
    const handler = new FinalizationHandler(
      new OxigraphStore(),
      undefined,
      resolver ? { resolveContextGraphOnChainId: resolver } : {},
    );

    await expect(resolve(handler)).resolves.toBeUndefined();
  });
});
