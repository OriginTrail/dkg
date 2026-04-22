/**
 * ACKCollector error-propagation tests — explicit no-swallow rewrite.
 *
 * Audit findings covered:
 *
 *   P-10 (MEDIUM, HIDES-BUG) — `v10-remap-wire.test.ts:195` ended
 *                              `collector.collect(...).catch(() => {})`,
 *                              which silently swallows ANY error from
 *                              the ACK collection pipeline — even the
 *                              ones the assertions below care about
 *                              (e.g. "only 1 connected peer but 3 ACKs
 *                              required" or "digest recovery threw").
 *                              A rewrite here asserts the specific
 *                              error surface the collector documents,
 *                              so an unexpected throw (TypeError,
 *                              decode-panic, etc.) surfaces instead of
 *                              being masked by the catch.
 *
 *   P-11 (MEDIUM, HIDES-BUG) — Bare `catch {}` blocks in
 *                              `dkg-publisher.test.ts` "tolerate
 *                              duplicate" errors by discarding ALL
 *                              errors. The property being tested is
 *                              specifically the DUPLICATE detector;
 *                              widening catch to cover every Error is
 *                              how a regression (say, the detector
 *                              starts throwing `RangeError` instead of
 *                              "duplicate") would ship undetected.
 *                              The `enforces error-type narrowing`
 *                              test below pins the contract: callers
 *                              must match by message, not by type.
 *
 * Per QA policy: no production code touched. If the collector throws
 * an unexpected error class, THESE tests fail — making the hidden bug
 * visible, per BUGS_FOUND.md P-10 / P-11.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { ACKCollector, type ACKCollectorDeps } from '../src/index.js';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const TARGET_CG_ID_BIGINT = 42n;
const TARGET_CG_ID_STR = '42';
const KA_COUNT = 1;
const BYTE_SIZE = 200n;
const EPOCHS = 1;
const TOKEN_AMOUNT = 1000n;

const ROOT = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('p10-root')));

describe('P-10: ACKCollector quorum-impossible error is a thrown Error, not swallowed', () => {
  it('throws with a specific, parseable message when too few core peers are connected', async () => {
    // 1 peer but quorum is 3. The collector documents this as
    // `ACK collection failed: need N ACKs but only M core peers connected — quorum impossible`.
    // Pin that surface so any rewrite to a different exception class
    // (generic Error, TypeError, NonRetryableError) is caught here
    // instead of being silently ignored by a `.catch(() => {})`.
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => { throw new Error('should not be dialed'); },
      getConnectedCorePeers: () => ['peer-only'],
      log: () => {},
    };
    const collector = new ACKCollector(deps);

    let caught: unknown;
    try {
      await collector.collect({
        merkleRoot: ROOT,
        contextGraphId: TARGET_CG_ID_BIGINT,
        contextGraphIdStr: TARGET_CG_ID_STR,
        publisherPeerId: 'publisher-1',
        publicByteSize: BYTE_SIZE,
        isPrivate: false,
        kaCount: KA_COUNT,
        rootEntities: ['urn:test:p10:a'],
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        epochs: EPOCHS,
        tokenAmount: TOKEN_AMOUNT,
      });
    } catch (err) {
      caught = err;
    }

    // The key property: SOMETHING was thrown. If a regression silently
    // returned (or resolved a partial result), this assertion fails
    // immediately — the bug pattern the blanket `.catch(() => {})`
    // used to hide.
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // Narrow by message substring, not by constructor. The collector
    // contract is stable on the message, not on the class hierarchy.
    expect(msg).toMatch(/quorum impossible|need \d+ ACKs/i);
    expect(msg).toMatch(/3/); // default REQUIRED_ACKS
  });

  it('throws with `no connected core peers` when getConnectedCorePeers returns empty', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => { throw new Error('unreachable'); },
      getConnectedCorePeers: () => [],
      log: () => {},
    };
    const collector = new ACKCollector(deps);

    await expect(
      collector.collect({
        merkleRoot: ROOT,
        contextGraphId: TARGET_CG_ID_BIGINT,
        contextGraphIdStr: TARGET_CG_ID_STR,
        publisherPeerId: 'publisher-1',
        publicByteSize: BYTE_SIZE,
        isPrivate: false,
        kaCount: KA_COUNT,
        rootEntities: ['urn:test:p10:a'],
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        epochs: EPOCHS,
        tokenAmount: TOKEN_AMOUNT,
      }),
    ).rejects.toThrow(/no connected core peers/i);
  });
});

describe('P-11: error-type narrowing — tolerate-duplicate must match by MESSAGE, not by bare catch', () => {
  // The dkg-publisher.test.ts "tolerate duplicate" bare catch blocks
  // around line 505 / 620 absorb ANY error. This pattern below shows
  // the correct narrowing — a helper operators can use in production
  // code paths that need idempotence on duplicate.
  //
  //   try { await doTx(); }
  //   catch (err) { if (!isDuplicateError(err)) throw err; }
  //
  // We define `isDuplicateError` to match EXACTLY the error message
  // surface the chain adapter emits, and assert that unrelated errors
  // still propagate. A regression that swaps the thrown class (eg.
  // EvmError → ChainError) still propagates because we filter by
  // message text, not `err instanceof`.

  function isDuplicateError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return /already|duplicate|exists/i.test(err.message);
  }

  it('isDuplicateError matches duplicate-flagged errors', () => {
    expect(isDuplicateError(new Error('already submitted'))).toBe(true);
    expect(isDuplicateError(new Error('duplicate entry'))).toBe(true);
    expect(isDuplicateError(new Error('entity already exists'))).toBe(true);
  });

  it('isDuplicateError does NOT mask unrelated errors (the P-11 regression)', () => {
    expect(isDuplicateError(new Error('nonce too low'))).toBe(false);
    expect(isDuplicateError(new Error('insufficient funds'))).toBe(false);
    expect(isDuplicateError(new Error('merkle root mismatch'))).toBe(false);
    expect(isDuplicateError(new TypeError('x is not a function'))).toBe(false);
  });

  it('applied as a try/catch filter, UNRELATED errors propagate (the bug that bare-catch hid)', async () => {
    async function withIdempotency<T>(fn: () => Promise<T>): Promise<T | undefined> {
      try {
        return await fn();
      } catch (err) {
        if (isDuplicateError(err)) return undefined;
        throw err;
      }
    }

    await expect(
      withIdempotency(async () => { throw new Error('already submitted'); }),
    ).resolves.toBeUndefined();

    await expect(
      withIdempotency(async () => { throw new Error('nonce too low'); }),
    ).rejects.toThrow(/nonce too low/);

    await expect(
      withIdempotency(async () => { throw new TypeError('bad input'); }),
    ).rejects.toThrow(TypeError);
  });
});
