/**
 * GH#2648 — the runtime's publish-authority answer for the async lift claim scan.
 *
 * Every lift lane is a ONE-WALLET lane (`createPublisherWalletChain` passes a single
 * `privateKey`, and `RuntimeEvmChainConfig` carries no `additionalKeys`), so a lane refused by a
 * curated context graph has no in-adapter rotation to fall back on — it can only fail, reset, and
 * claim the same job again. What this resolver owns is the runtime-wide answer the scan routes
 * on, and in particular the two ways it must NOT answer:
 *
 *  - a failed read must never shrink the authorized set, because an EMPTY set is the terminal
 *    verdict and a transient RPC error must not be able to condemn a job;
 *  - an adapter that cannot answer at all must disable the filter rather than speak for the pool.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { createPublishAuthorityResolver } from '../src/publisher-runner.js';

const AUTHORIZED = '0xd896f0E6000000000000000000000000000000aa';
const REFUSED = '0x3bccEeD2000000000000000000000000000000bb';
const CG = 453n;

function wallet(
  address: string,
  isAuthorizedPublisher?: ChainAdapter['isAuthorizedPublisher'],
  /**
   * Defaults to an ENFORCEABLE adapter, so each test states only what it is about. An adapter
   * that answers `isAuthorizedPublisher` but has no `ContextGraphs` binding is the separate
   * `unenforced` case below.
   */
  isPublishAuthorityEnforceable: ChainAdapter['isPublishAuthorityEnforceable'] | 'omit' =
    async () => true,
): { address: string; identityId: bigint; publisher: DKGPublisher; chain: ChainAdapter } {
  return {
    address,
    identityId: 0n,
    publisher: {} as DKGPublisher,
    chain: (isAuthorizedPublisher
      ? {
        isAuthorizedPublisher,
        ...(isPublishAuthorityEnforceable === 'omit'
          ? {}
          : { isPublishAuthorityEnforceable }),
      }
      : {}) as ChainAdapter,
  };
}

describe('createPublishAuthorityResolver', () => {
  it('reports exactly the wallets the context graph admits, alongside every wallet asked', async () => {
    const resolve = createPublishAuthorityResolver([
      wallet(AUTHORIZED, async (_cg, address) => address === AUTHORIZED),
      wallet(REFUSED, async (_cg, address) => address === AUTHORIZED),
    ]);
    if (!resolve) throw new Error('expected a resolver');

    await expect(resolve(CG)).resolves.toEqual({
      kind: 'resolved',
      authorizedWalletIds: [AUTHORIZED],
      candidateWalletIds: [AUTHORIZED, REFUSED],
    });
  });

  it('reports an EMPTY authorized set when the graph admits none of the runtime wallets', async () => {
    // Authoritative and terminal: this is what fails the job instead of leaving it queued.
    const resolve = createPublishAuthorityResolver([
      wallet(AUTHORIZED, async () => false),
      wallet(REFUSED, async () => false),
    ]);
    if (!resolve) throw new Error('expected a resolver');

    const authority = await resolve(CG);
    expect(authority.kind).toBe('resolved');
    if (authority.kind !== 'resolved') throw new Error('unreachable');
    expect(authority.authorizedWalletIds).toEqual([]);
    expect(authority.candidateWalletIds).toEqual([AUTHORIZED, REFUSED]);
  });

  it('reports unknown — never a shrunken set — when ANY wallet read fails', async () => {
    // The load-bearing case. Dropping the unreadable wallet would leave `[AUTHORIZED]`, which
    // silently routes; worse, if the readable wallet were the refused one it would leave `[]`,
    // and a blip would terminally fail a job the node can publish.
    const resolve = createPublishAuthorityResolver([
      wallet(AUTHORIZED, async () => { throw new Error('rpc down'); }),
      wallet(REFUSED, async () => false),
    ]);
    if (!resolve) throw new Error('expected a resolver');

    await expect(resolve(CG)).resolves.toEqual({ kind: 'unknown' });
  });

  it('disables the filter when any wallet adapter cannot answer at all', async () => {
    // A NoChainAdapter (or a build predating the probe) means authority is UNENFORCEABLE here.
    // A partial answer across a mixed adapter set would be worse than none.
    expect(createPublishAuthorityResolver([
      wallet(AUTHORIZED, async () => true),
      wallet(REFUSED),
    ])).toBeUndefined();
    expect(createPublishAuthorityResolver([])).toBeUndefined();
  });

  it('reports unenforced when an adapter has no ContextGraphs binding', async () => {
    // `isAuthorizedPublisher` answers `true` BOTH for "authorized" and for "no policy contract
    // to ask". Folding the second into `authorizedWalletIds` reported an adapter that cannot
    // enforce anything as an affirmative per-wallet verdict, mixed it with truthful answers from
    // the other adapters, and let a lane claim jobs the graph never admitted — the transaction is
    // really sent and reverts on chain. `initContracts()` swallows a transient failure while
    // still marking the adapter initialized, so a lost binding is sticky for the process.
    const resolve = createPublishAuthorityResolver([
      wallet(AUTHORIZED, async (_cg, address) => address === AUTHORIZED),
      wallet(REFUSED, async () => true, async () => false),
    ]);
    if (!resolve) throw new Error('expected a resolver');

    await expect(resolve(CG)).resolves.toEqual({ kind: 'unenforced' });
  });

  it('treats an enforceability probe that throws as not enforceable', async () => {
    const resolve = createPublishAuthorityResolver([
      wallet(AUTHORIZED, async () => true),
      wallet(REFUSED, async () => true, async () => { throw new Error('rpc down'); }),
    ]);
    if (!resolve) throw new Error('expected a resolver');

    await expect(resolve(CG)).resolves.toEqual({ kind: 'unenforced' });
  });

  it('disables the filter when an adapter answers authority but cannot report enforceability', () => {
    // Same reasoning as a missing `isAuthorizedPublisher`: an adapter that cannot say whether it
    // enforces anything must not be spoken for.
    expect(createPublishAuthorityResolver([
      wallet(AUTHORIZED, async () => true),
      wallet(REFUSED, async () => true, 'omit'),
    ])).toBeUndefined();
  });

  it('asks every wallet about the context graph it was given', async () => {
    const probe = vi.fn(async () => true);
    const resolve = createPublishAuthorityResolver([
      wallet(AUTHORIZED, probe),
      wallet(REFUSED, probe),
    ]);
    if (!resolve) throw new Error('expected a resolver');

    await resolve(CG);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith(CG, AUTHORIZED);
    expect(probe).toHaveBeenCalledWith(CG, REFUSED);
  });
});
