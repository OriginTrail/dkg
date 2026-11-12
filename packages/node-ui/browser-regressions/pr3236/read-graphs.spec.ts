import { test, expect, type Page } from '@playwright/test';

// The "Search across assets" section and the query view's toggle in a real
// browser, against a node stubbed with page.route. Globs end in `**` so a
// query string still matches.
const cg = '0x1111111111111111111111111111111111111111/browser-preview';
const LAYERS: Record<string, string> = { 'working-memory': 'wm', 'shared-working-memory': 'swm', 'verifiable-memory': 'vm' };

function settings(rows: Record<string, string>) {
  const effective = Object.fromEntries(Object.keys(LAYERS).map(layer => [layer, rows[layer] ?? 'off']));
  return {
    policy: { enabled: true, layers: Object.keys(LAYERS) },
    contextGraphs: [{
      contextGraphId: cg,
      layers: rows,
      effective: { layers: effective, viewSemantics: 'per-asset' },
      readGraphs: Object.entries(rows).filter(([, mode]) => mode !== 'off')
        .map(([layer]) => ({ readGraph: `urn:rg:${layer}`, contextGraphId: cg, layer: LAYERS[layer], state: 'ready', generation: 1 })),
    }],
  };
}

// The first page load transforms the query view's modules.
test.describe.configure({ timeout: 30_000 });

async function stubPage(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
}

test('the node admin switches a memory between Off, Preview and On, and Off asks first', async ({ page }) => {
  await stubPage(page);
  let rows: Record<string, string> = { 'verifiable-memory': 'serve' };
  const puts: unknown[] = [];
  await page.route('**/api/store/read-graphs/settings**', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { layers: Record<string, string> };
      puts.push(body);
      rows = { ...rows, ...body.layers };
      await route.fulfill({ json: { ...settings(rows), changes: [] } });
    } else {
      await route.fulfill({ json: settings(rows) });
    }
  });
  await page.goto('/?view=read-graphs');

  const swm = page.locator('[data-layer="shared-working-memory"]');
  await expect(swm.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await swm.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(swm.getByRole('button', { name: 'Preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(swm.getByTestId('search-state')).toHaveText('Ready to turn on');
  expect(puts).toEqual([{ contextGraphId: cg, layers: { 'shared-working-memory': 'build' } }]);

  const vm = page.locator('[data-layer="verifiable-memory"]');
  await vm.getByRole('button', { name: 'Off', exact: true }).click();
  await expect(vm.getByTestId('search-state')).toHaveText('In use');
  await expect(vm.getByRole('group', { name: 'Turn off Published assets' })).toBeVisible();
  expect(puts).toHaveLength(1);
  await vm.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(vm.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(puts).toEqual([
    { contextGraphId: cg, layers: { 'shared-working-memory': 'build' } },
    { contextGraphId: cg, layers: { 'verifiable-memory': 'off' } },
  ]);
});

test('Search across assets asks for merged answers in a memory, and one that is not ready yet is explained', async ({ page }) => {
  await stubPage(page);
  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/query**', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (body.semantics === 'merged' && body.view === 'shared-working-memory') {
      await route.fulfill({ status: 503, headers: { 'Retry-After': '10' },
        json: { error: 'The view is not ready for a merged query', code: 'VIEW_NOT_READY', retryable: true } });
    } else {
      await route.fulfill({ json: { result: { type: 'bindings', bindings: [{ s: 'urn:a' }] }, semantics: body.semantics ?? 'per-asset' } });
    }
  });
  await page.goto('/?view=merged-query');

  const merged = page.getByRole('checkbox', { name: 'Search across assets' });
  await expect(page.locator('.v10-mlv-result-count')).toHaveText('1 result');
  await expect(merged).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Search in' }).selectOption('verifiable-memory');
  await merged.check();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.v10-mlv-result-count')).toHaveText('1 result · searched across assets');
  expect(bodies.at(-1)).toMatchObject({ contextGraphId: cg, view: 'verifiable-memory', semantics: 'merged' });

  await page.getByRole('combobox', { name: 'Search in' }).selectOption('shared-working-memory');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Search across assets is still getting ready for this memory.', { exact: false })).toBeVisible();
});
