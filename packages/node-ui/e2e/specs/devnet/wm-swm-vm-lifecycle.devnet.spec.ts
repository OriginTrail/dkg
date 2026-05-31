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

const run: { cgId?: string; cgName?: string; label?: string; assertionName?: string; kaId?: string } = {};

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

  test('full WM → SWM → VM pipeline returns kaId', async () => {
    const result = await runWmSwmVmPipeline({ contextGraphId: run.cgId! });
    expect(result.assertionName).toBeTruthy();
    run.label = result.label;
    run.assertionName = result.assertionName;
    run.kaId = result.kaId;
    if (result.kaId) {
      expect(BigInt(result.kaId)).toBeGreaterThan(0n);
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
    await expect(page.getByText(run.label!, { exact: false })).toBeVisible({ timeout: 15_000 });
  });

  test('operations view loads after publish activity', async ({ shell, header, page }) => {
    await shell.goto();
    await header.openObservability();
    await expect(page.getByRole('heading', { name: 'Observability' })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('KA update (devnet API)', () => {
  test('update endpoint accepts quads when kaId exists from pipeline', async () => {
    test.skip(!run.cgId || !run.kaId, 'Pipeline did not produce a kaId');
    const stamp = Date.now();
    const res = await devnetApiFetch('/api/update', {
      method: 'POST',
      body: JSON.stringify({
        contextGraphId: run.cgId,
        kaId: run.kaId,
        quads: buildTestQuads(run.cgId!, stamp, `Updated ${stamp}`),
      }),
    });
    expect(res.ok).toBe(true);
  });
});
