import { describe, expect, it } from 'vitest';

import {
  FINALIZED_CHAIN_READ_OWNERS,
  acquireFinalizedChainRead,
  finalizedChainReadRegistryDepth,
  isFinalizedChainAdmissionContention,
  resetFinalizedChainReadRegistryForTests,
  type FinalizedChainReadOwnerV1,
} from '../src/finalized-chain-read-admission.js';
import { CurrentFinalizedEvmCallErrorV1 } from '../src/current-finalized-evm-read-profile.js';

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

describe('contention classification is by IDENTITY, not by error code', () => {
  // `concurrency-saturated` is a SHARED code. Classifying on it would make the
  // RFC64 receiver defer — and silently retry for the whole deferral bound —
  // on failures that are real bugs or unrelated local overload.
  it('classifies only the refusal this module actually threw', async () => {
    resetFinalizedChainReadRegistryForTests();
    const gate = deferred<void>();
    const held = acquireFinalizedChainRead(
      { chainId: CHAIN, owner: 'rfc64' },
      () => gate.promise,
      (active, holder) => new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        `Chain ${CHAIN} already has ${active} in flight (held by ${holder})`,
      ),
    );
    await Promise.resolve();

    let refusal: unknown;
    try {
      await acquireFinalizedChainRead(
        { chainId: CHAIN, owner: 'w2-page' },
        async () => 'x',
        (active) => new CurrentFinalizedEvmCallErrorV1('concurrency-saturated', `busy:${active}`),
      );
    } catch (error) {
      refusal = error;
    }
    expect(isFinalizedChainAdmissionContention(refusal)).toBe(true);
    // …and through a wrapper, which is how it reaches the receiver.
    expect(isFinalizedChainAdmissionContention(
      Object.assign(new Error('precommit rejected'), { cause: refusal }),
    )).toBe(true);

    gate.resolve();
    await held;
  });

  it('does NOT classify the snapshot session reentrancy guard', () => {
    // `strict-current-finalized-evm-snapshot-rpc.ts` throws this when two
    // `session.read()` calls overlap. That is an integration bug: deferring it
    // would retry the misuse and then report a misleading lane-wait failure.
    const reentrancy = new CurrentFinalizedEvmCallErrorV1(
      'concurrency-saturated',
      'Current-finalized snapshot permits only one dynamic batch at a time',
    );
    expect(reentrancy.code).toBe('concurrency-saturated');
    expect(isFinalizedChainAdmissionContention(reentrancy)).toBe(false);
  });

  it('does NOT classify the one-shot read limit', () => {
    // The one-shot read has its own local gate with limit 4. Its saturation is
    // local overload, not the shared pinned-scan lane.
    const localLimit = new CurrentFinalizedEvmCallErrorV1(
      'concurrency-saturated',
      `Chain ${CHAIN} already has 4 current-finalized calls in flight`,
    );
    expect(isFinalizedChainAdmissionContention(localLimit)).toBe(false);
  });

  it('cannot be forged by constructing a look-alike error', () => {
    expect(isFinalizedChainAdmissionContention(
      Object.assign(new Error('nice try'), { code: 'concurrency-saturated' }),
    )).toBe(false);
    expect(isFinalizedChainAdmissionContention(undefined)).toBe(false);
    expect(isFinalizedChainAdmissionContention(null)).toBe(false);
    expect(isFinalizedChainAdmissionContention('concurrency-saturated')).toBe(false);
  });
});

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
