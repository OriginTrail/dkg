/**
 * WM → SWM → VM pipeline against live devnet, with UI verification.
 * Run: `pnpm test:e2e` — the Playwright webServer boots (or reuses) the devnet
 * itself, so no manual `scripts/devnet.sh start` is needed.
 */
import { test, expect } from '../../fixtures/base.js';
import {
  waitForDevnetStatus,
  devnetApiFetch,
  requireDevnetNode,
} from '../../helpers/devnet.js';
import {
  listContextGraphs,
  waitForContextGraph,
  runWmSwmVmPipeline,
  createWmAssertion,
  buildTestQuads,
  promoteAssertion,
} from '../../helpers/devnet-publish.js';

import { PRIMARY_CG, UI_NODE } from '../../helpers/real-node.js';
import { requireSeededUserGraph } from '../../helpers/lifecycle-fixture.js';

test.describe.configure({ mode: 'serial' });

const run: { cgId?: string; cgName?: string; label?: string; assertionName?: string; kaId?: string } = {};

test.beforeAll(async () => {
  await requireDevnetNode(test, UI_NODE);
  await waitForDevnetStatus(UI_NODE);
  await waitForContextGraph(PRIMARY_CG, UI_NODE);
  // The daemon lists system graphs too (often Agent Registry first). The UI
  // intentionally hides those. Bind to the fixture by ID, never list order.
  const graph = requireSeededUserGraph(await listContextGraphs(UI_NODE), PRIMARY_CG);
  run.cgId = graph.id;
  run.cgName = graph.name;
});

test.describe('WM → SWM → VM API pipeline', () => {
  test('creates WM assertion on devnet CG', async () => {
    const stamp = Date.now();
    const name = `e2e-wm-only-${stamp}`;
    const res = await createWmAssertion({
      contextGraphId: run.cgId!,
      nodeNum: UI_NODE,
      name,
      quads: buildTestQuads(run.cgId!, stamp, `WM Only ${stamp}`),
      alsoShareSwm: false,
    });
    expect(res.ok).toBe(true);
  });

  test('promotes assertion to SWM', async () => {
    const stamp = Date.now();
    const name = `e2e-swm-${stamp}`;
    const create = await createWmAssertion({
      contextGraphId: run.cgId!,
      nodeNum: UI_NODE,
      name,
      quads: buildTestQuads(run.cgId!, stamp, `SWM Test ${stamp}`),
      alsoShareSwm: false,
    });
    expect(create.ok).toBe(true);
    const promote = await promoteAssertion({ contextGraphId: run.cgId!, assertionName: name, nodeNum: UI_NODE });
    expect(promote.ok).toBe(true);
  });

  test('full WM → SWM → VM pipeline mints a confirmed on-chain kaId', async () => {
    const result = await runWmSwmVmPipeline({ contextGraphId: run.cgId!, nodeNum: UI_NODE });
    expect(result.assertionName).toBeTruthy();
    run.label = result.label;
    run.assertionName = result.assertionName;
    run.kaId = result.kaId;

    // 207 = the SWM/VM publish landed but the context-graph mirror failed
    // (`contextGraphError`) — a PARTIAL publish. publishToVm now REJECTS a 207 by
    // default (it would have thrown above before returning), so reaching this
    // point already guarantees a clean publish. We assert it here too as an
    // explicit, readable contract for this headline pipeline test — and as a
    // tripwire if anyone ever flips the helper's default to tolerate partials.
    expect(result.contextGraphError, `VM publish was partial (HTTP ${result.httpStatus}): ${result.contextGraphError}`).toBeFalsy();
    expect(result.httpStatus, 'VM publish should be a clean 200, not a 207 partial').toBe(200);

    // The daemon sends `kaId: String(result.kaId)`, so it always reaches us as a
    // numeric string ("0", "42", …) — never empty/undefined. A bare
    // `toBeTruthy()` would therefore pass even on "0", so assert the SHAPE
    // (clean message + guards BigInt() from throwing if the payload ever becomes
    // a UAL/DID string) and then the value.
    expect(result.kaId, 'VM publish returned 2xx but no numeric kaId — KA mint regressed').toMatch(/^\d+$/);
    // kaId 0 means the publish downgraded to a *tentative* local result
    // (`onChainResult?.batchId ?? 0n` in dkg-publisher). On the e2e devnet the
    // chain is live and quorum was confirmed by global-setup, so a confirmed
    // on-chain mint (kaId > 0) is the contract — a 0 here is a real regression,
    // not an expected outcome.
    expect(BigInt(result.kaId!), 'kaId is 0 — publish did not mint on-chain (tentative downgrade)').toBeGreaterThan(0n);
  });
});

test.describe('WM → SWM → VM UI verification', () => {
  test('published entity label appears in VM layer after refresh', async ({ shell, leftPanel, page }) => {
    expect(run.label, 'Pipeline must produce a label').toBeTruthy();
    expect(run.cgName, 'Seeded user graph must be ready').toBeTruthy();
    await shell.goto();
    await leftPanel.expandProject(run.cgName!);
    await page.locator('[data-layer="vm"]').click();
    // Observe a newly issued VM read, so a stale rendered label cannot stand
    // in for the refresh. The VM graph filter excludes VM metadata; WM/SWM
    // reads have different filters and must not satisfy this readiness check.
    const refreshed = page.waitForRequest(request => {
      if (!request.url().endsWith('/api/query') || request.method() !== 'POST') return false;
      const body = request.postDataJSON();
      return body.contextGraphId === run.cgId && body.sparql?.includes('_verifiable_memory_meta');
    });
    await page.getByRole('button', { name: 'Refresh Context Graph data' }).click();
    const response = await (await refreshed).response();
    expect(response?.ok(), 'Refresh must complete a successful VM read').toBe(true);
    await expect(page.getByText(run.label!, { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('operations view loads after publish activity', async ({ shell, header, page }) => {
    await shell.goto();
    await header.openObservability();
    await expect(page.getByRole('heading', { name: 'Observability' })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('KA update (devnet API)', () => {
  test('update endpoint requires a precomputed attestation for on-chain update', async () => {
    expect(run.cgId, 'Seeded user graph must be ready').toBeTruthy();
    expect(run.kaId, 'Pipeline must produce a kaId').toBeTruthy();
    const stamp = Date.now();
    const res = await devnetApiFetch('/api/update', {
      method: 'POST',
      nodeNum: UI_NODE,
      body: JSON.stringify({
        contextGraphId: run.cgId,
        kaId: run.kaId,
        quads: buildTestQuads(run.cgId!, stamp, `Updated ${stamp}`),
      }),
    });
    // On-chain KA update is gated behind a signed UpdateAuthorAttestation
    // (UpdateAuthorAttestation(kaId, newMerkleRoot, authorAddress), signed
    // off-band). A bare quads update with no `precomputedUpdateAttestation`
    // MUST be rejected. The previous expectation (`res.ok === true`) predated
    // that gate and was a false positive — it would have passed even if the
    // attestation enforcement regressed. Assert the real contract instead.
    expect(res.ok).toBe(false);
    const body = await res.text();
    expect(body).toMatch(/precomputedUpdateAttestation|attestation/i);
  });
});
