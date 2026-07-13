/**
 * VM-publish ACK-quorum guard (#1404 / #1408-C) — API-driven, deterministic.
 *
 * A CONFIRMED publish on this devnet is only possible when the whole ACK
 * machinery worked end-to-end: the publisher snapshots the connected core-peer
 * set (post-#1404 behind the bounded readiness gate), collects the real
 * 3-of-N StorageACK quorum from the OTHER core nodes (devnet.sh pins
 * minimumRequiredSignatures=3 — the mainnet value), every core-side ACK
 * handler answers instead of dead-airing (#1408-C), the CG publish
 * access-policy resolves from chain (the LU-5 leg of #1404), and the KC tx
 * confirms on-chain. A regression in ANY of those legs downgrades the publish
 * to tentative (kaId 0) or fails it outright — both fail loudly here.
 *
 * The old wm-swm-vm-lifecycle/ui-cycle specs covered this via slow UI-driven
 * flows and were trimmed from the CI lane (#1403); this spec keeps the
 * behavioral contract in CI with the fast API path only. The store-outage /
 * slow-RPC fault legs those PRs also fixed cannot be induced against a healthy
 * black-box devnet — they are pinned by the unit/integration suites shipped in
 * #1404 (publisher-runner-ack-readiness, policy-retry) and #1408
 * (storage-ack-core-unavailable and related store-outage scenarios).
 */
import { test, expect } from '../../fixtures/base.js';
import { requireDevnetNode, requireDevnetPrecondition, waitForDevnetStatus } from '../../helpers/devnet.js';
import {
  buildTestQuads,
  createWmAssertion,
  listContextGraphs,
  promoteAssertion,
  publishToVm,
} from '../../helpers/devnet-publish.js';
import { withSwmLock } from '../../helpers/swm-lock.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await requireDevnetNode(test, 1);
  await waitForDevnetStatus(1);
});

/** One full WM → SWM → VM pipeline; returns the publish response. */
async function publishFreshEntity(cgId: string, tag: string) {
  const stamp = Date.now();
  const name = `e2e-ack-quorum-${tag}-${stamp}`;
  // Hold the SWM mutation lock across create→promote→publish so a concurrent
  // spec's `clearAfter` wipe can never land between our promote and publish.
  return withSwmLock(async () => {
    const wm = await createWmAssertion({
      contextGraphId: cgId,
      name,
      quads: buildTestQuads(cgId, stamp, `ACK quorum ${tag} ${stamp}`),
    });
    expect(wm.ok, `WM create failed: ${wm.status} ${wm.body}`).toBe(true);
    const promoted = await promoteAssertion({ contextGraphId: cgId, assertionName: name });
    expect(promoted.ok, `SWM promote failed: ${promoted.status}`).toBe(true);
    return publishToVm({ contextGraphId: cgId, assertionName: name });
  });
}

function expectConfirmedOnChain(vm: { httpStatus: number; kaId?: string; status?: string }, which: string) {
  expect(vm.httpStatus, `${which}: expected a clean 200 publish`).toBe(200);
  // The daemon stringifies kaId; 0 means the publish downgraded to a TENTATIVE
  // local-only result — i.e. quorum was NOT reached or the chain leg was
  // skipped. On this devnet (registered CG, live chain, 3 reachable cores)
  // that is precisely the regression class #1404/#1408 fixed, so 0 is a fail.
  expect(vm.kaId, `${which}: no numeric kaId — KA mint regressed`).toMatch(/^\d+$/);
  expect(
    BigInt(vm.kaId!),
    `${which}: kaId is 0 — publish downgraded to tentative (ACK quorum not collected or chain leg skipped)`,
  ).toBeGreaterThan(0n);
}

test.describe('VM publish collects a REAL 3-of-N core ACK quorum', () => {
  test('a fresh publish confirms on-chain (quorum + policy + core ACK handlers all answered)', async () => {
    const cgs = await listContextGraphs(1);
    requireDevnetPrecondition(test, cgs.length === 0, 'No CGs on node1');
    expectConfirmedOnChain(await publishFreshEntity(cgs[0]!.id, 'first'), 'first publish');
  });

  test('an immediate back-to-back publish confirms too (fresh ACK snapshot each time)', async () => {
    // The #1404 failure mode was a publish firing at an unlucky INSTANT
    // (core-peer set snapshotted mid-settle → "quorum impossible"). Publishing
    // again with zero pause re-runs the snapshot + collection under the
    // least-settled timing this lane can produce deterministically.
    const cgs = await listContextGraphs(1);
    requireDevnetPrecondition(test, cgs.length === 0, 'No CGs on node1');
    expectConfirmedOnChain(await publishFreshEntity(cgs[0]!.id, 'second'), 'back-to-back publish');
  });
});
