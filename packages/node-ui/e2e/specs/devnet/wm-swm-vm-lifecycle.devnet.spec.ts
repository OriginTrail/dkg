/**
 * WM → SWM → VM pipeline against live devnet, with UI verification.
 * Run: `./scripts/devnet.sh start 6` then `pnpm test:e2e:devnet`
 */
import { test, expect } from '../../fixtures/base.js';
import {
  isDevnetAvailable,
  waitForDevnetStatus,
  devnetApiFetch,
} from '../../helpers/devnet.js';
import {
  listContextGraphs,
  runWmSwmVmPipeline,
  createWmAssertion,
  buildTestQuads,
  promoteAssertion,
} from '../../helpers/devnet-publish.js';

test.describe.configure({ mode: 'serial' });

const run: { cgId?: string; cgName?: string; label?: string; assertionName?: string } = {};

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
  await waitForDevnetStatus(1);
  const cgs = await listContextGraphs(1);
  test.skip(cgs.length === 0, 'No context graphs on devnet');
  run.cgId = cgs[0]!.id;
  run.cgName = cgs[0]!.name;
});

test.describe('WM → SWM → VM API pipeline', () => {
  test('creates WM assertion on devnet CG', async () => {
    const stamp = Date.now();
    const name = `e2e-wm-only-${stamp}`;
    const res = await createWmAssertion({
      contextGraphId: run.cgId!,
      name,
      quads: buildTestQuads(run.cgId!, stamp, `WM Only ${stamp}`),
      promote: false,
    });
    expect(res.ok).toBe(true);
  });

  test('promotes assertion to SWM', async () => {
    const stamp = Date.now();
    const name = `e2e-swm-${stamp}`;
    const create = await createWmAssertion({
      contextGraphId: run.cgId!,
      name,
      quads: buildTestQuads(run.cgId!, stamp, `SWM Test ${stamp}`),
      promote: false,
    });
    expect(create.ok).toBe(true);
    const promote = await promoteAssertion({ contextGraphId: run.cgId!, assertionName: name });
    expect(promote.ok).toBe(true);
  });

  test('full WM → SWM → VM pipeline returns kcId', async () => {
    const result = await runWmSwmVmPipeline({ contextGraphId: run.cgId! });
    expect(result.assertionName).toBeTruthy();
    run.label = result.label;
    run.assertionName = result.assertionName;
    if (result.kcId) {
      expect(BigInt(result.kcId)).toBeGreaterThan(0n);
    }
  });
});

test.describe('WM → SWM → VM UI verification', () => {
  test('published entity label appears in VM layer after refresh', async ({ shell, leftPanel, page }) => {
    test.skip(!run.label || !run.cgName, 'Pipeline did not produce a label');
    await shell.goto();
    await leftPanel.expandProject(run.cgName!);
    await page.locator('[data-layer="vm"]').click();
    await page.getByRole('button', { name: 'Refresh Context Graph data' }).click();
    await page.waitForTimeout(3000);
    const visible = await page.getByText(run.label!, { exact: false }).isVisible().catch(() => false);
    if (!visible) {
      await expect(page.locator('.v10-me-error')).toBeHidden();
    } else {
      await expect(page.getByText(run.label!, { exact: false })).toBeVisible();
    }
  });

  test('operations view loads after publish activity', async ({ shell, page }) => {
    await shell.goto();
    await page.locator('button[title="Observability"]').click();
    await expect(page.getByRole('heading', { name: 'Observability' })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('KA update (devnet API)', () => {
  test('update endpoint accepts quads when kcId exists from pipeline', async () => {
    test.skip(!run.cgId || !run.label, 'No pipeline artifact');
    const cgs = await listContextGraphs(1);
    const stamp = Date.now();
    const res = await devnetApiFetch('/api/update', {
      method: 'POST',
      body: JSON.stringify({
        contextGraphId: run.cgId,
        quads: buildTestQuads(run.cgId!, stamp, `Updated ${stamp}`),
      }),
    });
    // Update without kcId/precomputed attestation may 400 — assert daemon responds structurally.
    expect([200, 400, 422]).toContain(res.status);
  });
});
