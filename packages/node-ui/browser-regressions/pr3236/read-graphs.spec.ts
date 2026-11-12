import { test, expect, type Page } from '@playwright/test';

// The read-graphs section and the query view's Merged toggle in a real
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

test('the node admin switches a layer\'s read graphs, and Off asks first', async ({ page }) => {
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
  await swm.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(swm.getByRole('button', { name: 'Build', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(swm.getByTestId('read-graph-state')).toHaveText('Ready');
  expect(puts).toEqual([{ contextGraphId: cg, layers: { 'shared-working-memory': 'build' } }]);

  const vm = page.locator('[data-layer="verifiable-memory"]');
  await vm.getByRole('button', { name: 'Off', exact: true }).click();
  await expect(vm.getByRole('group', { name: 'Turn off Verifiable memory read graphs' })).toBeVisible();
  expect(puts).toHaveLength(1);
  await vm.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(vm.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(puts).toEqual([
    { contextGraphId: cg, layers: { 'shared-working-memory': 'build' } },
    { contextGraphId: cg, layers: { 'verifiable-memory': 'off' } },
  ]);
});

test('the Merged toggle asks for merged answers in a view, and a merged view that is not ready is explained', async ({ page }) => {
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

  const merged = page.getByRole('checkbox', { name: 'Merged' });
  await expect(page.locator('.v10-mlv-result-count')).toHaveText('1 result');
  await expect(merged).toBeDisabled();
  await page.getByRole('combobox', { name: 'View' }).selectOption('verifiable-memory');
  await merged.check();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.v10-mlv-result-count')).toHaveText('1 result · matched merged');
  expect(bodies.at(-1)).toMatchObject({ contextGraphId: cg, view: 'verifiable-memory', semantics: 'merged' });

  await page.getByRole('combobox', { name: 'View' }).selectOption('shared-working-memory');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('The merged view is not ready: its read graph is still being built or repaired.', { exact: false })).toBeVisible();
});
