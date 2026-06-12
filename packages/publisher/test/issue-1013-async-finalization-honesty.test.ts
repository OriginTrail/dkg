/**
 * Issue-liveness repro for GH #1013 — "Private publishAsync can finalize locally
 * with provisional UAL but no on-chain provenance."
 * https://github.com/OriginTrail/dkg/issues/1013
 *
 * When a PRIVATE publish reaches a chain-registered context graph but cannot
 * collect storage ACKs (peers can't see the ciphertext), the publisher stores
 * it locally and returns `status: 'tentative'` with a provisional
 * `t<operationId>` UAL — NOT an on-chain KA. `mapPublishResultToLiftJobSuccess`
 * then maps EVERY tentative-without-onChain result to a SUCCESSFUL `finalized`
 * lift job (`mode: 'local'`). So `captureID → finalized → UAL` reports success
 * even though nothing is on chain / in Verifiable Memory — the invariant every
 * integration relies on is violated.
 *
 * The mapper cannot today tell an HONEST local finalize (no chain configured at
 * all) from a DISHONEST one (private payload that SHOULD have gone on chain but
 * couldn't collect ACKs). The fix threads that reason through
 * (`localChainSkipReason`) and rejects the dishonest case.
 *
 * This test asserts the CORRECT (post-fix) behaviour, so it is RED today
 * (the bug is live) and turns GREEN once the fix lands; it stays red until #1013 is fixed.. Pure
 * function under test — no store, no chain, no network.
 */
import { describe, expect, it } from 'vitest';
import { mapPublishResultToLiftJobSuccess } from '../src/index.js';
import type { PublishResult } from '../src/publisher.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = process.env.RUN_ISSUE_LIVENESS === '1';


function tentativeResult(localChainSkipReason: 'no-chain' | 'private-no-acks'): PublishResult {
  // A tentative, off-chain result (no `onChainResult`) carrying a provisional
  // UAL — exactly what `finalizeIntentionalLocalPublish` produces. The
  // `localChainSkipReason` discriminator is the signal the fix keys on; an
  // unfixed mapper ignores the extra field entirely.
  return {
    kaId: 0n,
    ual: 'did:dkg:evm:31337/0xpublisher/t-provisional-op',
    merkleRoot: new Uint8Array([0x12, 0x34]),
    kaManifest: [],
    status: 'tentative',
    localChainSkipReason,
  } as unknown as PublishResult;
}

describe.runIf(LIVENESS_ENABLED)('GH #1013 — async lift must not report a private off-chain publish as finalized', () => {
  it(
    'rejects a private-no-acks tentative result instead of mapping it to a finalized lift job',
    () => {
      // Control: a genuinely chain-less local publish is a legitimate local
      // finalize — it must keep mapping cleanly (no regression for offline use).
      expect(() =>
        mapPublishResultToLiftJobSuccess({ publishResult: tentativeResult('no-chain'), walletId: 'wallet-1' }),
      ).not.toThrow();

      // CORRECT (post-fix): a PRIVATE publish that was destined for a registered
      // chain but never reached it (no storage ACKs) must NOT be presented as a
      // finalized success — the mapper must reject it. Today it returns
      // `{ status: 'finalized', finalization: { mode: 'local' } }`, so this does
      // NOT throw → the assertion fails → the bug is reproduced.
      expect(() =>
        mapPublishResultToLiftJobSuccess({ publishResult: tentativeResult('private-no-acks'), walletId: 'wallet-1' }),
      ).toThrow();
    },
  );
});
