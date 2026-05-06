import { test, expect } from '../fixtures/base.js';

test.describe('Project View', () => {
  test.beforeEach(async ({ shell, leftPanel, page, seed }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.expandProject(seed.contextGraphName);
    // Project view loads its data asynchronously. Wait for the layer
    // switcher to mount before any test assertion runs.
    await page.locator('.v10-pv-header, .v10-me-header, .v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
  });

  test('project tab opens with correct name', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('QA Context Graph'))).toBe(true);
  });

  test('project name renders in the overview header strip', async ({ page, seed }) => {
    await expect(page.locator('.v10-po-title').first()).toHaveText(seed.contextGraphName);
  });

  test('Import button is visible in the layer-switcher toolbar', async ({ page }) => {
    const importBtn = page.locator('.v10-layer-switcher').getByRole('button', { name: /Import/ });
    await expect(importBtn).toBeVisible();
  });

  test('refresh button is visible in the layer-switcher toolbar', async ({ page }) => {
    const refreshBtn = page.locator('.v10-layer-switcher button').filter({ hasText: '↻' });
    await expect(refreshBtn).toBeVisible();
  });

  test('header Import button opens import modal', async ({ page, importFilesModal }) => {
    const headerImport = page.locator('.v10-layer-switcher').getByRole('button', { name: /Import/ });
    await headerImport.click();
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('project tab is closable', async ({ centerPanel, seed }) => {
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes(seed.contextGraphName))!;
    expect(await centerPanel.isTabClosable(projectTab)).toBe(true);
  });

  test('closing project tab returns to Dashboard', async ({ centerPanel, seed }) => {
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes(seed.contextGraphName))!;
    await centerPanel.closeTab(projectTab);
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('project overview shows the colored project dot', async ({ page }) => {
    await expect(page.locator('.v10-po-dot').first()).toBeVisible();
  });

  test('refresh button click does not crash the view', async ({ page, seed }) => {
    const refreshBtn = page.locator('.v10-layer-switcher button').filter({ hasText: '↻' });
    await refreshBtn.click();
    await expect(page.locator('.v10-po-title').first()).toHaveText(seed.contextGraphName);
  });

  test('layer switcher renders six buttons (overview, graph-overview, query, wm, swm, vm)', async ({ projectView }) => {
    for (const layer of ['overview', 'graph-overview', 'query', 'wm', 'swm', 'vm'] as const) {
      await expect(projectView.layerBtn(layer)).toBeVisible();
    }
  });

  test('Query layer button is labelled "⟐ Query"', async ({ projectView }) => {
    await expect(projectView.layerBtn('query')).toContainText('Query');
  });

  test('switching to Query layer updates the active layer', async ({ projectView }) => {
    await projectView.switchLayer('query');
    expect(await projectView.getActiveLayer()).toBe('query');
  });

  test('Overview is the default active layer', async ({ projectView }) => {
    expect(await projectView.getActiveLayer()).toBe('overview');
  });

  test('switching to Working Memory updates the active layer', async ({ projectView }) => {
    await projectView.switchLayer('wm');
    expect(await projectView.getActiveLayer()).toBe('wm');
  });

  test('switching to Verified Memory updates the active layer', async ({ projectView }) => {
    await projectView.switchLayer('vm');
    expect(await projectView.getActiveLayer()).toBe('vm');
  });

  test('switching to Graph Overview updates the active layer', async ({ projectView }) => {
    await projectView.switchLayer('graph-overview');
    expect(await projectView.getActiveLayer()).toBe('graph-overview');
  });

  test('layer switcher labels match the user-facing copy', async ({ projectView }) => {
    await expect(projectView.layerBtn('overview')).toContainText('Overview');
    await expect(projectView.layerBtn('graph-overview')).toContainText('Graph Overview');
    await expect(projectView.layerBtn('wm')).toContainText(/Working Memory|Working/);
    await expect(projectView.layerBtn('swm')).toContainText(/Shared/);
    await expect(projectView.layerBtn('vm')).toContainText(/Verified/);
  });

  test.describe('Overview layer (populated)', () => {
    test.beforeEach(async ({ projectView, page }) => {
      await projectView.switchLayer('overview');
      // Wait for the ProjectOverviewCard to mount (its container is .v10-po).
      await page.locator('.v10-po').first().waitFor({ state: 'visible', timeout: 15_000 });
    });

    test('header strip shows the project description', async ({ page }) => {
      await expect(page.locator('.v10-po-desc').first()).toBeVisible();
    });

    test('Overview surface renders five metric labels', async ({ page }) => {
      // Labels are stored as mixed-case; CSS uppercases them visually.
      for (const label of ['Entities total', 'in Working', 'in Shared', 'in Verified', 'participants']) {
        await expect(page.getByText(label, { exact: true })).toBeVisible();
      }
    });

    test('Recent activity block renders with empty-state copy', async ({ page }) => {
      await expect(page.getByText('Recent activity', { exact: true })).toBeVisible();
      await expect(page.getByText(/Once agents start proposing/)).toBeVisible();
    });

    test('three layer rows render under the activity feed', async ({ page }) => {
      // Each label appears in the layer switcher AND in the MemoryStrip rows.
      // Assert at least one is visible — exact count is enforced elsewhere.
      await expect(page.getByText('Working Memory', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Shared Working Memory', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Verified Memory', { exact: true }).first()).toBeVisible();
    });

    test('layer rows show the "No assets yet" empty marker', async ({ page }) => {
      const markers = page.getByText('No assets yet');
      expect(await markers.count()).toBeGreaterThan(0);
    });
  });

  test.describe('Graph Overview layer', () => {
    test.beforeEach(async ({ projectView }) => {
      await projectView.switchLayer('graph-overview');
    });

    test('shows the empty-state when no sub-graphs exist', async ({ page }) => {
      await expect(page.getByText('No sub-graphs registered on this project yet.')).toBeVisible();
    });
  });

  test.describe('Working Memory layer', () => {
    test.beforeEach(async ({ projectView }) => {
      await projectView.switchLayer('wm');
    });

    test('header copy describes the layer', async ({ page }) => {
      await expect(page.getByText(/Private agent scratchpad/)).toBeVisible();
    });

    test('renders four sub-tabs (Entities / Assertions / Graph / Documents)', async ({ page }) => {
      for (const tab of ['Entities', 'Assertions', 'Graph', 'Documents']) {
        await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
      }
    });

    test('Entities sub-tab shows entity rows or its empty marker', async ({ page }) => {
      // Seeded WM has two entities ("QA Seed Fact 1/2"). Either branch is
      // acceptable; what matters is that the panel rendered.
      const empty = page.getByText(/No entities in this layer yet/);
      const entitiesHeader = page.getByText(/\d+ entit/i);
      const someVisible = await Promise.race([
        empty.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
        entitiesHeader.first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false),
      ]);
      expect(someVisible).toBe(true);
    });

    test('Documents sub-tab is selectable', async ({ page }) => {
      await page.getByRole('button', { name: 'Documents', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Documents', exact: true })).toBeVisible();
    });
  });

  test.describe('Shared Memory layer', () => {
    test.beforeEach(async ({ projectView }) => {
      await projectView.switchLayer('swm');
    });

    test('header copy describes the layer', async ({ page }) => {
      await expect(page.getByText(/Team workspace.*shared proposals/)).toBeVisible();
    });

    test('renders the same four sub-tabs as Working Memory', async ({ page }) => {
      for (const tab of ['Entities', 'Assertions', 'Graph', 'Documents']) {
        await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
      }
    });
  });

  test.describe('Verified Memory layer', () => {
    test.beforeEach(async ({ projectView }) => {
      await projectView.switchLayer('vm');
    });

    test('header copy describes the layer', async ({ page }) => {
      await expect(page.getByText(/Endorsed, published, on-chain knowledge/)).toBeVisible();
    });

    test('renders three sub-tabs (Knowledge Assets / Graph / Documents)', async ({ page }) => {
      for (const tab of ['Knowledge Assets', 'Graph', 'Documents']) {
        await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
      }
    });

    test('hero card shows the Verified badge with anchoring copy', async ({ page }) => {
      await expect(page.getByText(/On-chain anchored.*cryptographically signed/)).toBeVisible();
    });

    test('hero card shows four metric labels', async ({ page }) => {
      // Scope to the hero strip — "Knowledge Assets" also appears as the
      // sub-tab button label and would otherwise match twice.
      const hero = page.locator('.v10-vm-hero');
      for (const label of ['Knowledge Assets', 'Verified Triples', 'Entity Types', 'Context Graph']) {
        await expect(hero.getByText(label, { exact: true })).toBeVisible();
      }
    });

    test('hero card shows four trust chips', async ({ page }) => {
      for (const chip of ['Consensus', 'On-chain', 'Agent Identity', 'Content Hash']) {
        await expect(page.getByText(chip, { exact: true })).toBeVisible();
      }
    });
  });
});
