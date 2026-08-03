import { describe, expect, it } from 'vitest';

import {
  FINALIZED_CHAIN_READ_OWNERS,
  acquireFinalizedChainRead,
  finalizedChainReadRegistryDepth,
  resetFinalizedChainReadRegistryForTests,
  type FinalizedChainReadOwnerV1,
} from '../src/finalized-chain-read-admission.js';

const CHAIN = '84532';
const OTHER_CHAIN = '31337';

/** A saturation error factory shaped like the transport's own. */
const saturated = (active: number) => new Error(`saturated:${active}`);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('finalized chain-read admission registry', () => {
  it('is PROCESS-WIDE: two independently obtained handles share one permit', async () => {
    // This is the whole point of the module, and the reason it exists at all.
    // The pre-existing gate was created inside `createStrictFinalizedEndpointRunnerV1`,
    // so every caller that built its own transport got its OWN gate — and
    // `CURRENT_FINALIZED_EVM_SNAPSHOT_MAX_CONCURRENT_PER_CHAIN_V1 = 1` ("one
    // heavyweight pinned scan per chain") enforced nothing between callers.
    // RFC64 constructs its scope per precommit invocation, so two concurrent
    // precommits on one chain both admitted.
    resetFinalizedChainReadRegistryForTests();
    const first = deferred<string>();

    const held = acquireFinalizedChainRead(
      { chainId: CHAIN, owner: 'rfc64' },
      () => first.promise,
      saturated,
    );
    await Promise.resolve();
    expect(finalizedChainReadRegistryDepth(CHAIN)).toBe(1);

    await expect(
      acquireFinalizedChainRead({ chainId: CHAIN, owner: 'w2-page' }, async () => 'second', saturated),
    ).rejects.toThrow('saturated:1');

    first.resolve('first');
    expect(await held).toBe('first');
    expect(finalizedChainReadRegistryDepth(CHAIN)).toBe(0);
  });

  it('keys on the chain id ALONE, so a different owner is not a different lane', async () => {
    // If the key were `${chainId}:${owner}`, the assertion above would pass
    // vacuously for two same-owner callers while RFC64 and W2 still ran
    // concurrently — the exact failure this registry exists to prevent.
    resetFinalizedChainReadRegistryForTests();
    const gate = deferred<void>();
    const owners: FinalizedChainReadOwnerV1[] = [...FINALIZED_CHAIN_READ_OWNERS];
    expect(owners.length).toBeGreaterThan(1);

    const held = acquireFinalizedChainRead(
      { chainId: CHAIN, owner: owners[0]! },
      () => gate.promise,
      saturated,
    );
    await Promise.resolve();

    for (const owner of owners.slice(1)) {
      await expect(
        acquireFinalizedChainRead({ chainId: CHAIN, owner }, async () => 'x', saturated),
      ).rejects.toThrow(/^saturated:1$/);
    }

    gate.resolve();
    await held;
  });

  it('does not couple distinct chains', async () => {
    resetFinalizedChainReadRegistryForTests();
    const gate = deferred<void>();
    const held = acquireFinalizedChainRead(
      { chainId: CHAIN, owner: 'rfc64' },
      () => gate.promise,
      saturated,
    );
    await Promise.resolve();

    await expect(
      acquireFinalizedChainRead({ chainId: OTHER_CHAIN, owner: 'w2-page' }, async () => 'ok', saturated),
    ).resolves.toBe('ok');

    gate.resolve();
    await held;
  });

  it('releases the permit on throw, not only on success', async () => {
    resetFinalizedChainReadRegistryForTests();
    await expect(
      acquireFinalizedChainRead({ chainId: CHAIN, owner: 'rfc64' }, async () => {
        throw new Error('boom');
      }, saturated),
    ).rejects.toThrow('boom');
    expect(finalizedChainReadRegistryDepth(CHAIN)).toBe(0);

    // …and the lane is genuinely reusable afterwards, which a decrement that
    // ran but left the map at a stale value would not give us.
    await expect(
      acquireFinalizedChainRead({ chainId: CHAIN, owner: 'w2-page' }, async () => 'after', saturated),
    ).resolves.toBe('after');
  });

  it('reports the holding owner to the saturation factory', async () => {
    // Without this, an operator seeing "chain 84532 already has 1 in flight"
    // cannot tell whether RFC64 or W2 is the one holding it, which is the
    // first question asked when a lane appears stuck.
    resetFinalizedChainReadRegistryForTests();
    const gate = deferred<void>();
    const held = acquireFinalizedChainRead(
      { chainId: CHAIN, owner: 'rfc64' },
      () => gate.promise,
      saturated,
    );
    await Promise.resolve();

    let seenHolder: FinalizedChainReadOwnerV1 | undefined;
    await expect(
      acquireFinalizedChainRead({ chainId: CHAIN, owner: 'w2-page' }, async () => 'x', (active, holder) => {
        seenHolder = holder;
        return new Error(`saturated:${active}:${holder}`);
      }),
    ).rejects.toThrow('saturated:1:rfc64');
    expect(seenHolder).toBe('rfc64');

    gate.resolve();
    await held;
  });

  it('exposes a runtime-FROZEN owner tuple, not just an `as const` one', async () => {
    // `as const` is compile-time only. Config validation reads this tuple while
    // admission checks a Set derived from it — if the tuple were mutable, a
    // consumer could widen one side and create split-brain behaviour where a
    // config validates but the run is refused.
    expect(Object.isFrozen(FINALIZED_CHAIN_READ_OWNERS)).toBe(true);
    const before = [...FINALIZED_CHAIN_READ_OWNERS];
    expect(() => (FINALIZED_CHAIN_READ_OWNERS as unknown as string[]).push('mutant-owner')).toThrow();
    expect([...FINALIZED_CHAIN_READ_OWNERS]).toEqual(before);
  });

  it('rejects an unknown owner rather than silently admitting it', async () => {
    resetFinalizedChainReadRegistryForTests();
    await expect(
      acquireFinalizedChainRead(
        { chainId: CHAIN, owner: 'not-an-owner' as FinalizedChainReadOwnerV1 },
        async () => 'x',
        saturated,
      ),
    ).rejects.toThrow(/owner/i);
    expect(finalizedChainReadRegistryDepth(CHAIN)).toBe(0);
  });

  it('rejects a noncanonical chain id so two spellings cannot become two lanes', async () => {
    // '084532' and '84532' are the same chain. If both were accepted as keys,
    // the process-wide guarantee would hold per SPELLING, not per chain.
    resetFinalizedChainReadRegistryForTests();
    await expect(
      acquireFinalizedChainRead({ chainId: '084532', owner: 'rfc64' }, async () => 'x', saturated),
    ).rejects.toThrow(/chain id/i);
    await expect(
      acquireFinalizedChainRead({ chainId: '', owner: 'rfc64' }, async () => 'x', saturated),
    ).rejects.toThrow(/chain id/i);
  });
});
