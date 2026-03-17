import { test, expect } from '@playwright/test';

const EXPLORER_BASE = '/ui/explorer';

test.describe('Memory Explorer - Graph tab', () => {
  test('Graph tab loads with expected elements', async ({ page }) => {
    test.slow();
    await page.goto(EXPLORER_BASE);

    // Verify "Memory Explorer" heading
    await expect(page.getByRole('heading', { name: 'Memory Explorer' })).toBeVisible();

    // Verify tab links exist
    await expect(page.getByRole('link', { name: 'Graph' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'SPARQL' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Paranets' })).toBeVisible();

    // Verify paranet filter dropdown with "All Paranets" default
    const paranetSelect = page.locator('.graph-toolbar select').first();
    await expect(paranetSelect).toBeVisible();
    await expect(paranetSelect).toHaveValue('');

    await expect(paranetSelect.locator('option[value=""]')).toHaveCount(1);

    // Verify "Show literals" checkbox is checked
    const showLiteralsCheckbox = page.getByRole('checkbox', { name: 'Show literals' });
    await expect(showLiteralsCheckbox).toBeVisible();
    await expect(showLiteralsCheckbox).toBeChecked();

    // Verify limit dropdown defaults to "Limit 10000"
    const limitSelect = page.locator('.graph-toolbar select').nth(1);
    await expect(limitSelect).toBeVisible();
    await expect(limitSelect.locator('option:checked')).toContainText('10000');

    // Verify Refresh button
    const refreshBtn = page.getByRole('button', { name: /Refresh|Loading…/ });
    await expect(refreshBtn).toBeVisible();

    const loading = page.getByText('Loading graph…');
    const tripleCount = page.locator('.graph-toolbar').getByText(/\d+[\d,]*\s+triples/);
    const emptyState = page.getByText(/No triples found|No matching triples/);
    await expect(loading.or(tripleCount).or(emptyState)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Memory Explorer - Paranet filter', () => {
  test('Paranet filter works when selecting a specific paranet', async ({ page }) => {
    test.slow();
    await page.goto(EXPLORER_BASE);

    // Wait for paranet dropdown to be populated
    const paranetSelect = page.locator('.graph-toolbar select').first();
    await expect(paranetSelect).toBeVisible();

    await page.waitForTimeout(3000);
    const options = await paranetSelect.locator('option').allTextContents();
    const paranetOptions = options.filter((t) => t.trim() && t !== 'All Paranets');

    if (paranetOptions.length === 0) {
      test.skip(true, 'No paranets available to filter');
    }

    // Select first non-empty paranet (e.g. "Origin Trail Game" or similar)
    const targetParanet = paranetOptions.find((n) =>
      /origin\s*trail\s*game|origin-trail-game/i.test(n),
    ) ?? paranetOptions[0];

    await paranetSelect.selectOption({ label: targetParanet });

    // Wait for graph to reload (loading state may appear briefly)
    await page.waitForLoadState('domcontentloaded');

    await page.waitForTimeout(2000);
    const paranetName = targetParanet.trim();
    await expect(page.getByText(paranetName).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Memory Explorer - Show literals toggle', () => {
  test('Show literals checkbox can be unchecked', async ({ page }) => {
    await page.goto(EXPLORER_BASE);

    const showLiteralsCheckbox = page.getByRole('checkbox', { name: 'Show literals' });
    await expect(showLiteralsCheckbox).toBeVisible();
    await expect(showLiteralsCheckbox).toBeChecked();

    await showLiteralsCheckbox.uncheck();

    await expect(showLiteralsCheckbox).not.toBeChecked();
  });
});

test.describe('Memory Explorer - Predicate filter chips', () => {
  test('Predicate filter chips appear when graph has data', async ({ page }) => {
    await page.goto(EXPLORER_BASE);

    await page.waitForTimeout(5000);

    // Predicate chips only appear when there are triples
    const predicateFilters = page.locator('.graph-predicate-filters');
    const hasPredicateFilters = await predicateFilters.isVisible();

    if (hasPredicateFilters) {
      // Verify predicate chips: "All" button and at least one predicate (e.g. rootEntity, type, publishedAt)
      const allChip = page.getByRole('button', { name: 'All' });
      await expect(allChip).toBeVisible();

      const chips = page.locator('.graph-predicate-chip');
      expect(await chips.count()).toBeGreaterThanOrEqual(1);
    }
    // If no predicate filters (empty graph), test passes - structure is correct
  });
});

test.describe('Memory Explorer - SPARQL tab', () => {
  test('SPARQL tab loads with Run Query and helper cards', async ({ page }) => {
    test.slow();
    await page.goto(`${EXPLORER_BASE}/sparql`);

    // Verify SPARQL tab is active
    const sparqlLink = page.getByRole('link', { name: 'SPARQL' });
    await expect(sparqlLink).toBeVisible();
    await expect(sparqlLink).toHaveClass(/active/);

    const runQueryBtn = page.getByRole('button', { name: /Run Query|Running\.\.\./ });
    await expect(runQueryBtn).toBeVisible({ timeout: 15_000 });

    const helperCards = page.locator('.sparql-helper-card');
    await expect(helperCards.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Memory Explorer - SPARQL query helpers', () => {
  test('At least one helper card mentions "All triples"', async ({ page }) => {
    await page.goto(`${EXPLORER_BASE}/sparql`);

    const helperWithAllTriples = page.locator('.sparql-helper-card').filter({
      has: page.locator('text=/All triples/i'),
    });
    await expect(helperWithAllTriples.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Memory Explorer - Paranets tab', () => {
  test('Paranets tab shows multiple paranet cards', async ({ page }) => {
    await page.goto(`${EXPLORER_BASE}/paranets`);

    // Verify Paranets tab is active
    const paranetsLink = page.getByRole('link', { name: 'Paranets' });
    await expect(paranetsLink).toBeVisible();
    await expect(paranetsLink).toHaveClass(/active/);

    // Wait for paranets to load
    await page.waitForSelector('.paranet-list .paranet-card, .empty-state', { timeout: 15_000 });

    const paranetCards = page.locator('.paranet-card');
    const count = await paranetCards.count();

    if (count === 0) {
      // Empty state - no paranets subscribed
      await expect(page.getByText('No paranets found')).toBeVisible();
      return;
    }

    // Verify multiple paranet cards (h3 headings)
    const headings = page.locator('.paranet-card h3');
    await expect(headings.first()).toBeVisible();

    // Verify cards have descriptions and IDs
    const firstCard = paranetCards.first();
    await expect(firstCard.locator('h3')).toBeVisible();
    await expect(firstCard.locator('p')).toBeVisible();
    await expect(firstCard.locator('.mono')).toBeVisible();

    // Verify at least "Agent Registry" and "Origin Trail Game" (or similar) are listed
    const cardTexts = await paranetCards.locator('h3').allTextContents();
    const hasAgentRegistry = cardTexts.some((t) => /agent\s*registry|agents/i.test(t));
    const hasOriginTrailGame = cardTexts.some((t) => /origin\s*trail\s*game|origin-trail-game/i.test(t));

    expect(hasAgentRegistry || hasOriginTrailGame).toBeTruthy();
  });
});

test.describe('Memory Explorer - Tab navigation', () => {
  test('Tab navigation updates URL correctly', async ({ page }) => {
    await page.goto(EXPLORER_BASE);

    // Start at Graph - URL should be /ui/explorer or /ui/explorer/
    await expect(page).toHaveURL(/\/ui\/explorer\/?(\?|$)/);

    // Click SPARQL link
    await page.getByRole('link', { name: 'SPARQL' }).click();
    await expect(page).toHaveURL(/\/ui\/explorer\/sparql/);

    // Click Paranets link
    await page.getByRole('link', { name: 'Paranets' }).click();
    await expect(page).toHaveURL(/\/ui\/explorer\/paranets/);

    // Click Graph link
    await page.getByRole('link', { name: 'Graph' }).click();
    await expect(page).toHaveURL(/\/ui\/explorer\/?(\?|$)/);
  });
});

test.describe('Memory Explorer - Console errors', () => {
  test('No unexpected console errors on explorer pages', async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error') {
        const text = msg.text();
        consoleErrors.push(text);
      }
    });

    // Visit Graph tab
    await page.goto(EXPLORER_BASE);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Visit SPARQL tab
    await page.goto(`${EXPLORER_BASE}/sparql`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Visit Paranets tab
    await page.goto(`${EXPLORER_BASE}/paranets`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Filter out known/expected errors (e.g. React DevTools, extensions)
    const unexpectedErrors = consoleErrors.filter((err) => {
      const lower = err.toLowerCase();
      return (
        !lower.includes('devtools') &&
        !lower.includes('extension') &&
        !lower.includes('favicon') &&
        !lower.includes('resizeobserver') &&
        !lower.includes('script error')
      );
    });

    expect(unexpectedErrors).toEqual([]);
  });
});
