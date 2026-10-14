import { test, expect, type Page } from '@playwright/test';
import { OxigraphStore } from '../../../storage/dist/index.js';
import { DKGQueryEngine } from '../../../query/dist/dkg-query-engine.js';
const owner = '0x1111111111111111111111111111111111111111'; const cg = `${owner}/browser-preview`;
let store: OxigraphStore;
test.beforeEach(async ({ page }) => {
  store = new OxigraphStore(); const engine = new DKGQueryEngine(store); const base = `did:dkg:context-graph:${cg}`;
  for (let i = 0; i < 6; i++) {
    const name = String(i).padStart(2, '0'); const graph = `${base}/_working_memory/${owner}/${name}`;
    const assertion = `urn:dkg:assertion:${cg}:${owner}:${name}`; const subject = `urn:entity:${name}`;
    await store.insert([
      { subject: assertion, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: `${base}/_meta` },
      { subject: assertion, predicate: 'http://dkg.io/ontology/assertionGraph', object: graph, graph: `${base}/_meta` },
      { subject, predicate: 'http://schema.org/name', object: JSON.stringify(i === 5 ? 'Later decision' : `Entity ${i}`), graph },
      ...(i === 5 ? [
        { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/decisions/Decision', graph },
        { subject, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: 'urn:dkg:agent:late-author', graph },
      ] : []),
    ]);
  }
  await page.route('**/api/**', async route => {
    if (route.request().url().endsWith('/api/query')) {
      const request = route.request().postDataJSON();
      const result = await engine.query(request.sparql, { ...request, agentAddress: owner });
      await route.fulfill({ json: { result: { type: 'bindings', bindings: result.bindings } } });
    } else if (route.request().url().includes('/events')) await route.fulfill({ contentType: 'text/event-stream', body: '' });
    else await route.fulfill({ json: { contextGraphs: [], events: [], agents: [], notifications: [], badgeCount: 0 } });
  });
});
test.afterEach(async () => { await store.close(); });
async function assertLargeGraphControl(page: Page, input: 'mouse' | 'touch') {
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.goto('/?view=large-graph');
  const showAll = page.getByRole('button', { name: 'Show all loaded nodes (3,001)', exact: true });
  await expect(page.locator('.v10-graph-view canvas').first()).toBeVisible();
  expect(await page.locator('.v10-graph-overlay').evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
  expect(await showAll.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('auto');
  const point = await page.locator('.v10-graph-legend > span').evaluate(node => {
    const rect = node.getClientRects()[0]; const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2;
    const underneath = document.elementFromPoint(x, y)!;
    (window as any).graphPointerDownCount = 0;
    underneath.addEventListener('pointerdown', () => { (window as any).graphPointerDownCount++; }, { once: true });
    return { x, y, onGraph: underneath.closest('.v10-graph-view') !== null };
  });
  expect(point.onGraph).toBe(true);
  if (input === 'mouse') await page.mouse.click(point.x, point.y);
  else await page.touchscreen.tap(point.x, point.y);
  expect(await page.evaluate(() => (window as any).graphPointerDownCount)).toBe(1);
  if (input === 'mouse') await showAll.click();
  else await showAll.tap();
  await expect(page.getByText('Showing all 3,001 loaded nodes.', { exact: true })).toBeVisible();
}
test.describe('large graph control with the application stylesheet', () => {
  test.use({ hasTouch: true });
  test('mouse can show all loaded nodes while legend text remains click-through', async ({ page }) => {
    test.setTimeout(60_000);
    await assertLargeGraphControl(page, 'mouse');
  });
  test('touch can show all loaded nodes while legend text remains click-through', async ({ page }) => {
    test.setTimeout(60_000);
    await assertLargeGraphControl(page, 'touch');
  });
});
test('native publisher literal UALs render and copy as lexical identifiers', async ({ page }) => {
  const ual = `did:dkg:evm:31337/${owner}/7`;
  await store.insert([{ subject: `urn:dkg:assertion:${cg}:${owner}:00`, predicate: 'http://dkg.io/ontology/reservedUal',
    object: JSON.stringify(ual), graph: `did:dkg:context-graph:${cg}/_meta` }]);
  await page.goto('/?view=assertions');
  const element = page.locator('.v10-item-ual').first();
  await expect(element).toHaveText(ual); await expect(element).toHaveAttribute('title', ual);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await element.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.press('ControlOrMeta+C');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ual);
});
test('incrementally ingested data images keep their WebGL sprite when the view changes', async ({ page }) => {
  await page.route('**/photo*', route => route.fulfill({ contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }));
  await page.goto('/?view=scene-data');
  await page.getByRole('button', { name: 'Add data image' }).click();
  const state = () => page.evaluate(() => {
    const viz = (window as any).regressionViz;
    return { image: viz?.model.nodes.get('urn:a')?.imageUrl,
      attached: viz?._renderer?._iconSprites?.get('urn:a')?.sprite?.parent != null };
  });
  const expected = { image: 'http://127.0.0.1:5186/photo one.png', attached: true };
  await expect.poll(state).toEqual(expected);
  await page.getByRole('button', { name: 'Switch default view' }).click();
  await expect.poll(state).toEqual(expected);
});
test('Memory Stack flags the five-graph preview and loads the sixth graph', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Only loaded memory is shown.', { exact: false })).toBeVisible();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('5');
  await expect(page.locator('.v10-memstack-cell-n-lbl').first()).toHaveText('loaded entities');
  await page.getByRole('button', { name: 'Load more graph data' }).click();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('6');
});
test('agent preview does not claim no contributions when the author is in a later graph', async ({ page }) => {
  await page.goto('/?view=agent');
  await expect(page.getByText('No entries for this agent in the loaded preview.', { exact: false })).toBeVisible();
  await expect(page.getByText("hasn't authored anything", { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more graph data' }).click();
  await expect(page.getByText('Later decision', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more graph data' })).toHaveCount(0);
});
test('real WebGL icons retain their Three.js scene parent after redraws', async ({ page }) => {
  await page.goto('/?view=scene');
  const hasIcon = () => page.evaluate(() => {
    const renderer = (window as any).regressionViz?._renderer;
    return renderer?._iconSprites?.get('urn:a')?.sprite?.parent != null;
  });
  await expect.poll(hasIcon).toBe(true);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Redraw scene' }).click();
    await page.waitForTimeout(50);
    expect(await hasIcon()).toBe(true);
  }
});
test('Memory Stack describes loaded counts when later SWM pages reduce WM membership', async ({ page }) => {
  const base = `did:dkg:context-graph:${cg}`;
  await store.insert(Array.from({ length: 6 }, (_, i) => {
    const graph = `${base}/_shared_memory/${owner}/${String(i).padStart(2, '0')}`;
    return i === 5
      ? ['urn:entity:00', 'urn:entity:01'].map(subject => ({ subject, predicate: 'http://schema.org/name', object: '"Promoted entity"', graph }))
      : [{ subject: `urn:shared:${i}`, predicate: 'http://schema.org/name', object: '"Shared entity"', graph }];
  }).flat());
  await page.goto('/');
  await expect(page.locator('.v10-memstack-cell-n').first()).toContainText('5');
  const initialCount = await page.locator('.v10-memstack-cell-n').first().innerText();
  const initialLabel = await page.locator('.v10-memstack-cell-n-lbl').first().innerText();
  await page.getByRole('button', { name: 'Load more graph data' }).click();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('4');
  expect(initialCount).toBe('5'); expect(initialLabel).toBe('loaded entities');
  await expect(page.getByText('lower bounds', { exact: false })).toHaveCount(0);
});
test('Memory Stack keeps a budget warning after graph continuation ends', async ({ page }) => {
  const graph = `did:dkg:context-graph:${cg}/_working_memory/${owner}/00`;
  await store.insert(Array.from({ length: 5001 }, (_, i) => ({
    subject: `_:blank${i}`, predicate: 'urn:value', object: '"value"', graph,
  })));
  await page.goto('/');
  await expect(page.getByText('Memory preview limit reached.', { exact: false })).toBeVisible();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('5000');
  await page.getByRole('button', { name: 'Load more graph data' }).click();
  await expect(page.getByRole('button', { name: 'Load more graph data' })).toHaveCount(0);
  await expect(page.getByText('Memory preview limit reached.', { exact: false })).toBeVisible();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('5001');
});
