/**
 * GH#1689 — context-graph publish-admission gate: the fail-closed paths and the
 * DIAGNOSTIC-ACCURACY invariant, pinned mechanically.
 *
 * Companion to the `#1689 publish admission` group in `evm-adapter.unit.test.ts`,
 * which covers the accept/reject matrix. This file covers what that matrix cannot:
 *
 *  1. The rejection message must be built from the SINGLE gate evaluation that
 *     produced it. A second, independent `version()` read can disagree with the
 *     first (failed reads are deliberately not memoized), and the resulting message
 *     would assert that the attested author was weighed and refused when it was
 *     never consulted — sending an operator to rewrite a publish policy over a
 *     transient RPC fault. A stub that throws on EVERY call cannot catch this;
 *     these use throw-once-then-succeed.
 *  2. "Fails closed on every path" is a security claim, so the remaining paths
 *     (unparseable version, no lifecycle bound) get a mechanical pin rather than an
 *     argument.
 *  3. One condition must not carry two error contracts: with an author in play the
 *     signer-pool branch rejects with the same structured error as the pinned
 *     branch — while the NO-author rejection keeps its byte-identical legacy string.
 *
 * No live RPC / Hardhat: every chain read is stubbed at `readContract`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  ChainRpcTransportError,
  isChainRpcTransportError,
} from '../src/chain-rpc-transport-error.js';
import {
  EVMChainAdapter,
  InsufficientPublisherFundsError,
  PublisherNotAuthorizedForContextGraphError,
  isPublisherNotAuthorizedForCgError,
  formatPublisherNotAuthorizedForCgMessage,
  type EVMAdapterConfig,
} from '../src/evm-adapter.js';
// Imported from the module that OWNS it, never re-typed as a literal, so a change
// to the production threshold cannot silently un-pin these tests.
import { ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION } from '../src/evm-adapter-base.js';
import { PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE } from '@origintrail-official/dkg-core';

const CG = 7n;
const AUTHOR = '0x1111111111111111111111111111111111111111';
const lc = (s: string) => s.toLowerCase();
const PK_A = `0x${'1'.repeat(64)}`;
const PK_B = `0x${'2'.repeat(64)}`;

/** One patch below the threshold, derived so it cannot drift into a second
 *  ACCEPTING version if the production constant ever moves. */
const BELOW_THRESHOLD = (() => {
  const [major, minor, patch] = ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION.split('.').map(Number);
  expect(patch).toBeGreaterThan(0);
  return `${major}.${minor}.${patch - 1}`;
})();

interface ReadCounts { isAuthorizedPublisher: number; version: number }

/**
 * Adapter whose only chain surface is a stubbed `readContract`, so the REAL gate
 * code path runs (semver compare, address-keyed memo, fail-closed catch) instead of
 * being stubbed over.
 *
 * @param authorized lowercase addresses the CG authorizes.
 * @param version    per-call `version()` behaviour: a string resolves, an Error
 *                   instance is thrown. An array is consumed one entry per call
 *                   (the last entry repeats), which is what makes a
 *                   blip-then-success sequence expressible.
 * @param opts.noLifecycle omit the lifecycle handle entirely.
 */
function makeAdapter(
  authorized: string[],
  version: string | Error | Array<string | Error>,
  opts: { noLifecycle?: boolean; extraKeys?: string[] } = {},
) {
  const config: EVMAdapterConfig = {
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: '0x0000000000000000000000000000000000000001',
    privateKey: PK_A,
    additionalKeys: opts.extraKeys,
    allowNoAdminSigner: true,
    chainId: 'evm:31337',
    staticNetwork: false,
  } as EVMAdapterConfig;
  const a = new EVMChainAdapter(config) as any;
  a.initialized = true;

  const counts: ReadCounts = { isAuthorizedPublisher: 0, version: 0 };
  const versions = Array.isArray(version) ? [...version] : [version];
  a.contracts = {
    contextGraphs: { __stub: 'contextGraphs' },
    knowledgeAssetsLifecycle: opts.noLifecycle
      ? undefined
      : { getAddress: async () => '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' },
  };
  a.readContract = async (_contract: unknown, _label: string, method: string, ...args: unknown[]) => {
    if (method === 'isAuthorizedPublisher') {
      counts.isAuthorizedPublisher += 1;
      return authorized.includes(String(args[1]).toLowerCase());
    }
    if (method === 'version') {
      counts.version += 1;
      const next = versions.length > 1 ? versions.shift()! : versions[0];
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`unexpected read: ${method}`);
  };
  return { a, counts, pool: a.signerPool as ethers.Wallet[] };
}

const caught = async (fn: () => Promise<unknown>): Promise<any> => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got success');
};

describe('#1689 publish admission — diagnostic accuracy [CH-1689-D]', () => {
  it('a version() blip does NOT produce a message claiming the author was weighed and refused', async () => {
    // The gate's read throws, so the author is never carried to an authorization
    // read. A LATER read would succeed — the exact sequence a re-deriving message
    // builder gets wrong. (d)-style stubs that throw every time cannot catch this.
    const { a, counts } = makeAdapter(
      [AUTHOR.toLowerCase()],
      [new Error('transient RPC fault'), ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION],
    );
    const payer = a.signerPool[0].address;

    const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));

    expect(error).toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
    // The load-bearing assertion: the author was NOT consulted, so the message must
    // not claim it was refused.
    expect(error.message).not.toContain('nor the attested author');
    expect(error.message).toContain('the deployed version could not be read');
    // ...and the rejection must be explained from the gate's own evaluation, i.e.
    // WITHOUT going back to the chain. Re-deriving cost up to two extra reads.
    expect(counts.version).toBe(1);
  });

  it('when the author IS consulted and refused, the message says so and names both principals', async () => {
    const { a } = makeAdapter([], ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION);
    const payer = a.signerPool[0].address;

    const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));

    expect(error.message).toContain('neither the paying wallet');
    expect(error.message).toContain('nor the attested author');
    expect(error.message).toContain(payer);
    expect(error.message).toContain(AUTHOR);
    expect(error.attestedAuthorAddress).toBe(AUTHOR);
  });

  it('an un-rotated lifecycle is reported as a version gate, not as a refused author', async () => {
    const { a } = makeAdapter([AUTHOR.toLowerCase()], BELOW_THRESHOLD);
    const payer = a.signerPool[0].address;

    const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));

    expect(error.message).not.toContain('nor the attested author');
    expect(error.message).toContain(
      `requires KnowledgeAssetsLifecycle >= ${ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION}`,
    );
    expect(error.message).toContain(`deployed version is ${BELOW_THRESHOLD}`);
  });

  // The facts are computed ONCE at throw time. If they live only in the rendered
  // message, the next consumer question — "not rotated yet, or author refused?" —
  // forces message-parsing, which is the exact coupling this PR removes. So the
  // thrown object must expose what the formatter was given, and the two must agree.
  it('the thrown error carries the structured facts its message was rendered from', async () => {
    const { a } = makeAdapter([AUTHOR.toLowerCase()], BELOW_THRESHOLD);
    const payer = a.signerPool[0].address;

    const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));

    // The two fields that answer the question without touching `message`.
    expect(error.details.attestedAuthorConsidered).toBe(false);
    expect(error.details.deployedLifecycleVersion).toBe(BELOW_THRESHOLD);
    expect(error.details.minLifecycleVersion).toBe(ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION);
    expect(error.details.contextGraphId).toBe(CG);
    expect(lc(error.details.payerAddress)).toBe(lc(payer));
    expect(error.details.attestedAuthorAddress).toBe(AUTHOR);

    // Facts and text must describe the same rejection — a message rendered from
    // different values than the object reports would be worse than either alone.
    expect(error.message).toBe(formatPublisherNotAuthorizedForCgMessage(error.details));

    // Frozen: one error's diagnosis cannot be mutated into disagreeing with its text.
    expect(Object.isFrozen(error.details)).toBe(true);

    // The flattened accessors are VIEWS over `details`, not copies. Assert they
    // agree with it, or a getter could quietly return something else and the
    // "single source of state" this shape exists to guarantee would be a fiction.
    // (Found by mutation: returning a constant from `payerAddress` was invisible
    // to every assertion above.)
    expect(error.payerAddress).toBe(error.details.payerAddress);
    expect(error.contextGraphId).toBe(error.details.contextGraphId);
    expect(error.attestedAuthorAddress).toBe(error.details.attestedAuthorAddress);
    expect(error.payerPoolAddresses).toBe(error.details.payerPoolAddresses);
  });

  it('carries the pool facts on a signer-pool rejection, author consulted and refused', async () => {
    const { a, pool } = makeAdapter([], ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION, {
      extraKeys: [PK_B],
    });

    const error = await caught(() => a._authorizedPublisherSigners(pool, CG, AUTHOR));

    // Author WAS weighed here (supported lifecycle) and refused — the opposite
    // diagnosis to the version-gated case above, distinguishable without parsing.
    expect(error.details.attestedAuthorConsidered).toBe(true);
    expect(error.details.deployedLifecycleVersion)
      .toBe(ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION);
    expect(error.details.payerPoolAddresses).toEqual(pool.map((w) => w.address));
    expect(error.message).toBe(formatPublisherNotAuthorizedForCgMessage(error.details));
    // Accessor agrees with the single source, including on the pool shape.
    expect(error.payerPoolAddresses).toBe(error.details.payerPoolAddresses);
    expect(error.payerAddress).toBe(error.details.payerAddress);
  });
});

describe('#1689 publish admission — fails closed on EVERY path [CH-1689-F]', () => {
  // "Unknown" must behave exactly like "unsupported": against an un-rotated chain a
  // relaxed gate would broadcast a transaction certain to fail on chain, burning gas.
  const unreadable: Array<[string, string | Error]> = [
    ['empty string', ''],
    ['non-numeric', 'unknown'],
    ['partial semver', '10.1'],
    ['read throws', new Error('CALL_EXCEPTION')],
  ];

  for (const [label, version] of unreadable) {
    it(`unparseable/unreadable version() (${label}) → author branch is NOT consulted`, async () => {
      const { a } = makeAdapter([AUTHOR.toLowerCase()], version);
      expect(await a.attestedAuthorPublishAuthorizationSupported()).toBe(false);
      const payer = a.signerPool[0].address;
      const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));
      expect(error.code).toBe(PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE);
      expect(error.message).not.toContain('nor the attested author');
    });
  }

  it('no lifecycle bound at all → author branch is NOT consulted, and no read is attempted', async () => {
    const { a, counts } = makeAdapter([AUTHOR.toLowerCase()], '10.9.9', { noLifecycle: true });
    // No lifecycle bound is a stable answer, not a transport failure: `version` is
    // null and `transportError` is absent, so this stays a terminal denial.
    expect(await a.deployedKnowledgeAssetsLifecycleVersion())
      .toEqual({ version: null });
    expect(await a.attestedAuthorPublishAuthorizationSupported()).toBe(false);
    expect(counts.version).toBe(0);

    const payer = a.signerPool[0].address;
    const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));
    expect(error.code).toBe(PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE);
    // Only the payer was read — the author was never carried to the chain.
    expect(counts.isAuthorizedPublisher).toBe(1);
  });

  it('the zero address is not a usable author: refused without a read (on-chain p.authorAddress is non-zero)', async () => {
    const { a, counts } = makeAdapter([], ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION);
    const admission = await a._cgAdmitsAttestedAuthor(CG, ethers.ZeroAddress);
    expect(admission).toEqual({ admitted: false, authorConsulted: false, deployedVersion: null });
    expect(counts.isAuthorizedPublisher).toBe(0);
    expect(counts.version).toBe(0);
  });
});

describe('#1689 publish admission — "cannot determine" is not "denied" [CH-1689-T]', () => {
  // The gate fails closed on ANY unreadable version — but the two reasons a version
  // can be unreadable have to reach the caller as different ERROR CLASSES:
  //
  //   deterministic (no `version()` to decode, garbage value) → a stable answer;
  //       reporting it as an authorization denial is correct and TERMINAL is right.
  //   transport exhaustion (503, ECONNRESET, timeout)         → no answer at all;
  //       reporting it as a denial is a false claim, and downstream it becomes a
  //       terminal `authority_forbidden` that no retry revisits — so one blip on a
  //       single-RPC node permanently kills a publish the chain would have accepted.
  //
  // Admission itself is unchanged in both cases: still false, still no transaction.
  // Only the class of the thrown error differs, and only on proven transport failure.
  const transportFailure = () => new ChainRpcTransportError(
    'RPC_ENDPOINTS_EXHAUSTED', 'all endpoints failed',
  );

  it('a TRANSPORT failure on the version read is rethrown raw, NOT as an authz denial', async () => {
    const { a } = makeAdapter([AUTHOR.toLowerCase()], transportFailure());
    const payer = a.signerPool[0].address;

    const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));

    // The transport error itself reaches the classifier, exactly as a transport
    // failure on the PAYER read already does — so the publisher can retry it.
    expect(isChainRpcTransportError(error)).toBe(true);
    expect(error.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(error).not.toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
    expect(error.code).not.toBe(PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE);
  });

  it('the same transport failure on the POOL branch is rethrown, not reported as a denial', async () => {
    const { a, pool } = makeAdapter([AUTHOR.toLowerCase()], transportFailure(), {
      extraKeys: [PK_B],
    });

    const error = await caught(() => a._authorizedPublisherSigners(pool, CG, AUTHOR));

    expect(isChainRpcTransportError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
  });

  it('a payer-authorized publish is UNAFFECTED by a version-read transport failure', async () => {
    // The author probe runs before the payer loop, so raising the transport error
    // where it is computed would break a publish that never needed the author.
    // It must only surface when we are actually about to reject.
    const { a, pool } = makeAdapter([], transportFailure(), { extraKeys: [PK_B] });
    const payerAuthorized = [pool[0].address.toLowerCase()];
    a.readContract = async (_c: unknown, _l: string, method: string, ...args: unknown[]) => {
      if (method === 'isAuthorizedPublisher') {
        return payerAuthorized.includes(String(args[1]).toLowerCase());
      }
      throw transportFailure();
    };

    await expect(a._authorizedPublisherSigners(pool, CG, AUTHOR))
      .resolves.toEqual([pool[0]]);
  });

  it('a DETERMINISTIC unreadable version stays a TERMINAL authorization denial', async () => {
    // `BAD_DATA` is the "this lifecycle has no version() to decode" case. It is a
    // stable answer, so it must NOT be rethrown as retryable — that would re-open
    // the forever-retry trap this PR closes. This is the row that fails if the
    // discriminator is widened from `isChainRpcTransportError` to
    // `isRetryableRpcError` (which counts BAD_DATA as retryable).
    const decodeFailure = Object.assign(new Error('could not decode result data'), {
      code: 'BAD_DATA',
    });
    const { a } = makeAdapter([AUTHOR.toLowerCase()], decodeFailure);
    const payer = a.signerPool[0].address;

    const error = await caught(() => a.resolvePinnedPublisherSigner(CG, payer, AUTHOR));

    expect(error).toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
    expect(error.code).toBe(PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE);
    expect(isChainRpcTransportError(error)).toBe(false);
  });
});

describe('#1689 publish admission — one condition, one error contract [CH-1689-C]', () => {
  it('signer-pool rejection WITH an author in play is the structured error, like the pinned branch', async () => {
    const { a, pool } = makeAdapter([], ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION, {
      extraKeys: [PK_B],
    });
    expect(pool.length).toBe(2);

    const error = await caught(() => a._authorizedPublisherSigners(pool, CG, AUTHOR));

    expect(error).toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
    expect(error.code).toBe(PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE);
    // A pool rejection weighed EVERY wallet, so it must not misdirect the operator
    // at one of them as "the paying wallet".
    expect(error.message).toContain('any of the 2 operational wallets in the signer pool');
    expect(error.message).toContain('nor the attested author');
    expect(error.payerPoolAddresses).toEqual(pool.map((w) => w.address));
  });

  it('signer-pool rejection with NO author keeps the byte-identical legacy error', async () => {
    const { a, pool } = makeAdapter([], ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION);

    const error = await caught(() => a._authorizedPublisherSigners(pool, CG));

    // Untyped by design: the string is pinned by chain-lifecycle-extra.test.ts and
    // upstream callers pattern-match it.
    expect(error).not.toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe(
      'No authorized publisher wallet found in signer pool for context graph 7. '
      + 'Ensure at least one configured wallet is permitted by on-chain publish authority.',
    );
  });

  it('an authorized author leaves the pool UNNARROWED on a single read', async () => {
    const { a, pool, counts } = makeAdapter(
      [AUTHOR.toLowerCase()],
      ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION,
      { extraKeys: [PK_B] },
    );
    await expect(a._authorizedPublisherSigners(pool, CG, AUTHOR)).resolves.toEqual(pool);
    expect(counts.isAuthorizedPublisher).toBe(1);
  });
});

describe('#1689 publish admission — createKnowledgeAssets threads the author [CH-1689-K]', () => {
  // The gates are mutation-proven, and the publisher forwards the author to the
  // PLANNER — but nothing asserted that `createKnowledgeAssets` itself passes
  // `params.author.address` into the gates it calls. Remove that threading and the
  // direct/sync publish path pre-rejects whenever only the author is authorized,
  // while planner tests, contract tests, protected-helper tests and publisher
  // forwarding all stay green. A line whose deletion nothing notices.
  //
  // So these drive the PUBLIC method and assert selection was REACHED: the
  // lifecycle handle throws a sentinel the instant a signer has been chosen, so
  // seeing the sentinel proves the gate admitted the publish, and seeing a
  // publish-authorization error proves it did not.
  const SENTINEL = 'SELECTION_REACHED_SENTINEL';

  function makePublishAdapter(authorized: string[], opts: { extraKeys?: string[] } = {}) {
    const { a, counts, pool } = makeAdapter(
      authorized, ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION, opts,
    );
    // Reached immediately after selection (`lifecycle.connect(txSigner)` then
    // `.getAddress()`), and before any transaction is built or sent.
    a.contracts.knowledgeAssetsLifecycle = {
      getAddress: async () => '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
      connect: () => ({ getAddress: async () => { throw new Error(SENTINEL); } }),
    };
    // Funding-aware selection must not be what rejects.
    a.getWalletFunding = async () => ({ native: 10n ** 18n, trac: 10n ** 18n });
    a.isWalletPublishFundable = async () => true;
    a.quoteRequiredPublishTokenAmount = async () => 0n;
    return { a, counts, pool };
  }

  const publishParams = (author: string, publisherAddress?: string) => ({
    publishOperationId: `0x${'ab'.repeat(32)}`,
    contextGraphId: CG,
    merkleRoot: new Uint8Array(32),
    knowledgeAssetsAmount: 1,
    byteSize: 128n,
    epochs: 1,
    tokenAmount: 0n,
    isImmutable: false,
    merkleLeafCount: 1,
    publisherNodeIdentityId: 1n,
    author: {
      address: author,
      signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      schemeVersion: 1,
    },
    ackSignatures: [],
    ...(publisherAddress ? { publisherAddress } : {}),
  });

  it('PINNED payer: an authorized author admits a payer the CG does not authorize', async () => {
    // Only the attested author is authorized — the pinned wallet is not.
    const { a, pool } = makePublishAdapter([AUTHOR.toLowerCase()]);
    const error = await caught(() => a.createKnowledgeAssets(
      publishParams(AUTHOR, pool[0].address),
    ));
    // Reaching the sentinel means the gate admitted and a signer was selected.
    expect(error.message).toBe(SENTINEL);
    expect(error).not.toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
  });

  it('UNPINNED pool: an authorized author admits the pool for funding-aware selection', async () => {
    const { a } = makePublishAdapter([AUTHOR.toLowerCase()], { extraKeys: [PK_B] });
    const error = await caught(() => a.createKnowledgeAssets(publishParams(AUTHOR)));
    expect(error.message).toBe(SENTINEL);
    expect(error).not.toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
  });

  // S3 — the site the class sweep found unguarded. `createKnowledgeAssets` passes
  // the author into `enrichInsufficientPublisherFundsError`, which decides whether a
  // funding failure is the TERMINAL `NO_FUNDED_PUBLISHER_WALLET` or a recoverable
  // wrong-pick. Removing that argument left every one of 883 chain tests green.
  //
  // Why the earlier test missed it: it called `enrichInsufficientPublisherFundsError`
  // DIRECTLY, so it pinned the inner hop (enrich → poolHasFundableSigner) and proved
  // nothing about whether anything calls it with the author. Per publisher-dev's rule
  // — for pass-through threading the only binding test asserts the value at the FAR
  // END of the chain through the public entry point — this drives the public method
  // and asserts the decision that threading actually changes.
  it('S3 far-end: an authorized author keeps the pool a viable reroute through the PUBLIC publish path', async () => {
    // Only the AUTHOR is authorized; the pinned payer is not (so admission comes via
    // the author) and the pinned payer is broke while another pool wallet is funded.
    const { a, pool } = makePublishAdapter([AUTHOR.toLowerCase()], { extraKeys: [PK_B] });
    const [pinned] = pool;
    // Unlike the selection tests above, this one must run PAST selection to the send,
    // so the lifecycle handle resolves normally instead of throwing the sentinel.
    a.contracts.knowledgeAssetsLifecycle = {
      getAddress: async () => '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
      connect: () => ({ getAddress: async () => '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' }),
    };
    a.getWalletFunding = async (address: string) => (
      address.toLowerCase() === pinned.address.toLowerCase()
        ? { native: 10n ** 18n, trac: 0n }
        : { native: 10n ** 18n, trac: 10n ** 18n }
    );
    a.isWalletPublishFundable = async (address: string) =>
      address.toLowerCase() !== pinned.address.toLowerCase();
    a.snapshotPublisherWalletBalances = async () => [];
    // Fail the send with a funds-shaped revert so the enrichment branch runs. This is
    // the last hop before `.catch()` → `enrichInsufficientPublisherFundsError`.
    const sendFailure = new Error('ERC20: transfer amount exceeds balance');
    a.dispatchSerializedV10Write = async () => { throw sendFailure; };

    const error = await caught(() => a.createKnowledgeAssets({
      ...publishParams(AUTHOR, pinned.address),
      // OT-RFC-43 Option-1 packed id: high 160 bits MUST be the author.
      reservedKaId: (BigInt(AUTHOR) << 96n) | 1n,
    }));

    // The author admits the pool, so a funded wallet IS a viable reroute: the original
    // error must survive so a retry can reroute. Drop the author at :3955 and this
    // becomes a TERMINAL NO_FUNDED — a recoverable job reported as unfixable.
    expect(error).not.toBeInstanceOf(InsufficientPublisherFundsError);
    expect(error).toBe(sendFailure);
  });

  // S8 — the bot's round-2 finding, confirmed unguarded by a clean class-sweep
  // measurement: removing the author from the planner's POOL branch left all 884
  // chain tests green. The pinned planner branch (S7) and the pool branch are
  // separate call sites; the existing planner coverage exercised the pinned one.
  //
  // Far-end assertion through the PUBLIC planner: with only the author authorized,
  // an UNPINNED plan must resolve. Drop the author at `evm-adapter-publish.ts:157`
  // and the pool narrows to payer-authorized wallets, finds none, and throws.
  it('S8 far-end: an authorized author lets the UNPINNED public planner resolve a plan', async () => {
    const { a, pool } = makeAdapter(
      [AUTHOR.toLowerCase()], ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION, { extraKeys: [PK_B] },
    );
    a.quoteRequiredPublishTokenAmount = async () => 0n;
    a.getWalletFunding = async () => ({ native: 10n ** 18n, trac: 10n ** 18n });
    a.isWalletPublishFundable = async () => true;
    a.selectFundedSignerOrThrow = async (candidates: any[]) => candidates[0];
    a._selectFundedCandidateOrThrow = async (plans: any[]) => plans[0];

    const plan = await a.resolvePublisherPublishPlan({
      contextGraphId: CG,
      effectiveByteSize: 100n,
      explicitPublishEpochs: 2,
      defaultPublishEpochs: 12,
      // No publisherAddress ⇒ the POOL branch.
      attestedAuthorAddress: AUTHOR,
    });

    expect(pool.map((w) => w.address)).toContain(plan.publisherAddress);
  });

  it('PINNED payer: with NEITHER principal authorized it still rejects (gate not simply bypassed)', async () => {
    // Guards the two above from passing for the wrong reason — if the threading
    // were replaced by "skip the gate", this would reach the sentinel too.
    const { a, pool } = makePublishAdapter([]);
    const error = await caught(() => a.createKnowledgeAssets(
      publishParams(AUTHOR, pool[0].address),
    ));
    expect(error).toBeInstanceOf(PublisherNotAuthorizedForContextGraphError);
    expect(error.code).toBe(PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE);
  });
});

describe('#1689 publish admission — author-aware NO_FUNDED enrichment [CH-1689-E]', () => {
  // `enrichInsufficientPublisherFundsError` decides whether a funding failure is the
  // TERMINAL `NO_FUNDED_PUBLISHER_WALLET` ("no wallet is a viable reroute") or a
  // recoverable wrong-pick. It answers that with `poolHasFundableSigner`, which must
  // be asked on the SAME two-principal rule the publish is held to: an attested
  // author the CG authorizes makes every funded wallet admissible.
  //
  // Nothing else guards the author argument at that call site. Drop it and the
  // payer-only NO_FUNDED tests still pass, while a recoverable reroute is
  // misreported as terminal — a misclassification in the same family as the bug
  // this PR fixes. Mutation-proven: removing the argument fails exactly this test.
  it('an authorized author keeps a fundable pool wallet a viable reroute (NOT terminal NO_FUNDED)', async () => {
    const { a, pool } = makeAdapter(
      // ONLY the attested author is authorized — no wallet in the pool is.
      [AUTHOR.toLowerCase()],
      ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION,
      { extraKeys: [PK_B] },
    );
    const [pinned, other] = pool;
    // The pinned payer is short on TRAC; the other pool wallet can cover the cost.
    a.getWalletFunding = async (address: string) => (
      address.toLowerCase() === pinned.address.toLowerCase()
        ? { native: 10n ** 18n, trac: 0n }
        : { native: 10n ** 18n, trac: 10n ** 18n }
    );
    a.isWalletPublishFundable = async (address: string) =>
      address.toLowerCase() !== pinned.address.toLowerCase();
    a.snapshotPublisherWalletBalances = async () => [];

    // A TRAC shortfall surfaces as a funds-shaped transferFrom revert.
    const original = new Error('ERC20: transfer amount exceeds balance');
    const enriched = await a.enrichInsufficientPublisherFundsError(
      original, pinned, CG, 1_000n, AUTHOR,
    );

    expect(enriched).not.toBeInstanceOf(InsufficientPublisherFundsError);
    // The original error is preserved so a retry can reroute to the funded wallet.
    expect(enriched).toBe(original);
    void other;
  });

  it('with no author, an unauthorized-and-unfunded pool is still terminal NO_FUNDED (unchanged)', async () => {
    // The payer-only behaviour this must not disturb: nothing admissible is
    // fundable, so the whole-pool diagnosis is correct and stays terminal.
    const { a, pool } = makeAdapter([], ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION, {
      extraKeys: [PK_B],
    });
    const [pinned] = pool;
    a.getWalletFunding = async () => ({ native: 10n ** 18n, trac: 0n });
    a.isWalletPublishFundable = async () => false;
    a.snapshotPublisherWalletBalances = async () => [];

    const enriched = await a.enrichInsufficientPublisherFundsError(
      new Error('ERC20: transfer amount exceeds balance'), pinned, CG, 1_000n,
    );

    expect(enriched).toBeInstanceOf(InsufficientPublisherFundsError);
  });
});

describe('#1689 publish admission — cross-package version coupling [CH-1689-V]', () => {
  // The client threshold and `KnowledgeAssetsLifecycle._VERSION` are two literals in
  // two packages maintained by different people. A mismatch fails NOTHING: the
  // contract compiles, the chain suite is green, the build is clean — and the fix is
  // simply dormant forever after the Hub rotation, with no signal anywhere. Prose
  // only works on someone who reads it, which is exactly the case that drifts, so
  // the coupling is pinned here instead. Same class of guard as `abi-pinning.test.ts`.
  const CONTRACT_PATH = join(
    import.meta.dirname, '..', '..', 'evm-module', 'contracts', 'KnowledgeAssetsLifecycle.sol',
  );

  it('the _VERSION the contract ships actually ACTIVATES the client gate', async () => {
    // Guard the guard: a moved/renamed contract must fail loudly here rather than
    // silently vacuous-pass, which would be the same silent failure one level up.
    expect(existsSync(CONTRACT_PATH), `contract source not found at ${CONTRACT_PATH}`).toBe(true);
    const source = readFileSync(CONTRACT_PATH, 'utf8');
    const shipped = /_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1];
    expect(shipped, 'could not read _VERSION from KnowledgeAssetsLifecycle.sol').toBeTruthy();

    // Drive the REAL gate with the REAL shipped version — a behavioural assertion,
    // not a string compare, so it also covers the semver comparison itself. Kills
    // both drift directions: raising the client threshold above what the contract
    // ships, and lowering the contract's `_VERSION` below the threshold.
    const { a } = makeAdapter([], shipped!);
    expect(
      await a.attestedAuthorPublishAuthorizationSupported(),
      `KnowledgeAssetsLifecycle._VERSION is "${shipped}" but the client gate requires `
      + `>= "${ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION}" — the #1689 fix would be `
      + 'DORMANT after rotation. Keep the two constants in step.',
    ).toBe(true);
  });
});

describe('#1689 publish admission — error predicate is throw-safe [CH-1689-P]', () => {
  it('classifies by code and by message marker', () => {
    const err = new PublisherNotAuthorizedForContextGraphError({
      contextGraphId: CG,
      payerAddress: AUTHOR,
      attestedAuthorConsidered: false,
      minLifecycleVersion: ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION,
    });
    expect(isPublisherNotAuthorizedForCgError(err)).toBe(true);
    // Constructing from details ALONE is now the only shape: the message is
    // derived, so an error whose text contradicts its own facts is unconstructible.
    expect(err.message).toBe(formatPublisherNotAuthorizedForCgMessage(err.details));
    // Code stripped by a re-wrap → the message prefix still classifies it.
    expect(isPublisherNotAuthorizedForCgError(
      new Error(formatPublisherNotAuthorizedForCgMessage({
        contextGraphId: CG,
        payerAddress: AUTHOR,
        attestedAuthorConsidered: false,
        minLifecycleVersion: ATTESTED_AUTHOR_PUBLISH_AUTHZ_MIN_KAL_VERSION,
      })),
    )).toBe(true);
    expect(isPublisherNotAuthorizedForCgError(new Error('unrelated'))).toBe(false);
    expect(isPublisherNotAuthorizedForCgError(null)).toBe(false);
    expect(isPublisherNotAuthorizedForCgError(undefined)).toBe(false);
  });

  it('a hostile value whose accessors throw does not take out the classifier', () => {
    // Exported API: callers hand it arbitrary CAUGHT values. A classification
    // helper must never become the failure it is classifying.
    const hostile = new Proxy({}, {
      get() { throw new Error('accessor exploded'); },
    });
    expect(() => isPublisherNotAuthorizedForCgError(hostile)).not.toThrow();
    expect(isPublisherNotAuthorizedForCgError(hostile)).toBe(false);

    const throwingCode = Object.defineProperty({}, 'code', {
      get() { throw new Error('code exploded'); },
    });
    expect(() => isPublisherNotAuthorizedForCgError(throwingCode)).not.toThrow();
  });
});
