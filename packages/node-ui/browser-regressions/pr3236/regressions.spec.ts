import { test, expect } from '@playwright/test';
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
test('Memory Stack flags the five-graph preview and loads the sixth graph', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Only loaded memory is shown.', { exact: false })).toBeVisible();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('≥ 5');
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
test('Memory Stack keeps a budget warning after graph continuation ends', async ({ page }) => {
  const graph = `did:dkg:context-graph:${cg}/_working_memory/${owner}/00`;
  await store.insert(Array.from({ length: 5001 }, (_, i) => ({
    subject: `_:blank${i}`, predicate: 'urn:value', object: '"value"', graph,
  })));
  await page.goto('/');
  await expect(page.getByText('Memory preview limit reached.', { exact: false })).toBeVisible();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('≥ 5000');
  await page.getByRole('button', { name: 'Load more graph data' }).click();
  await expect(page.getByRole('button', { name: 'Load more graph data' })).toHaveCount(0);
  await expect(page.getByText('Memory preview limit reached.', { exact: false })).toBeVisible();
  await expect(page.locator('.v10-memstack-cell-n').first()).toHaveText('≥ 5001');
});
