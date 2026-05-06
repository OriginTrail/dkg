import { test, expect } from '../fixtures/base.js';

test.describe('Bottom Panel', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('starts in collapsed state', async ({ bottomPanel }) => {
    expect(await bottomPanel.isCollapsed()).toBe(true);
  });

  test('has five tabs: Node Log, Transactions, Gossip, Agent Runs, SPARQL', async ({ bottomPanel }) => {
    const names = await bottomPanel.getTabNames();
    expect(names).toContain('Node Log');
    expect(names).toContain('Transactions');
    expect(names).toContain('Gossip');
    expect(names).toContain('Agent Runs');
    expect(names).toContain('SPARQL');
  });

  test('Node Log is the default active tab', async ({ bottomPanel }) => {
    const active = await bottomPanel.getActiveTabName();
    expect(active?.trim()).toBe('Node Log');
  });

  test('expanding shows Node Log content with filter input', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    const filter = page.locator('input[placeholder="Filter logs..."]');
    await expect(filter).toBeVisible();
  });

  test('Node Log shows multiple log lines', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 5_000 });
    const count = await bottomPanel.getLogLineCount();
    expect(count).toBeGreaterThan(0);
  });

  test('log lines contain timestamps and a [Module] tag (daemon log format)', async ({ bottomPanel, page }) => {
    // Previously skipped with the rationale "Node Log panel never displays
    // any lines (SSE wiring broken)". The companion test
    // "log output renders at least one line from the daemon" (below) IS
    // now green in CI, so the SSE/polling fetch is working — the skip
    // comment was stale. Unskipped to actually catch a regression in
    // log line FORMAT rather than just rendering.
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    const lines = await bottomPanel.getLogLines();
    expect(lines.some(l => /\d{4}-\d{2}-\d{2}/.test(l))).toBe(true);
    expect(lines.some(l => /\[[A-Za-z][A-Za-z0-9_-]+\]/.test(l))).toBe(true);
  });

  test('Transactions tab shows coming soon placeholder', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await bottomPanel.switchTab('Transactions');
    await expect(page.getByText('Transactions tab coming soon...')).toBeVisible();
  });

  test('Gossip tab shows coming soon placeholder', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await bottomPanel.switchTab('Gossip');
    await expect(page.getByText('Gossip tab coming soon...')).toBeVisible();
  });

  test('Agent Runs tab shows coming soon placeholder', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await bottomPanel.switchTab('Agent Runs');
    await expect(page.getByText('Agent Runs tab coming soon...')).toBeVisible();
  });

  test('SPARQL tab shows coming soon placeholder', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await bottomPanel.switchTab('SPARQL');
    await expect(page.getByText('SPARQL tab coming soon...')).toBeVisible();
  });

  test('switching tabs updates active state', async ({ bottomPanel }) => {
    await bottomPanel.toggle();
    await bottomPanel.switchTab('Gossip');
    const active = await bottomPanel.getActiveTabName();
    expect(active?.trim()).toBe('Gossip');
  });

  test('collapsing hides content area', async ({ bottomPanel }) => {
    await bottomPanel.toggle();
    expect(await bottomPanel.isCollapsed()).toBe(false);
    await bottomPanel.toggle();
    expect(await bottomPanel.isCollapsed()).toBe(true);
  });

  test('log filter input narrows the visible log lines', async ({ bottomPanel, page }) => {
    // Previously skipped on the assumption the filter wasn't wired. Source
    // verification: PanelBottom.tsx:20 calls
    // `api.fetchNodeLog({ q: filter || undefined })` inside a useEffect
    // that depends on `[filter]`. Filtering IS wired. Unskipped to catch
    // a regression where the filter param stops being passed.
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 10_000 });
    const before = await bottomPanel.getLogLineCount();
    expect(before).toBeGreaterThan(0);
    await bottomPanel.filterLogs('___no-such-token-in-any-log___');
    await expect.poll(() => bottomPanel.getLogLineCount(), { timeout: 5_000 }).toBeLessThan(before);
  });

  test('log output renders at least one line from the daemon', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    const lines = await bottomPanel.getLogLines();
    expect(lines.length).toBeGreaterThan(0);
  });

  // SKIPPED: same Node Log SSE bug — panel never receives lines.
  test.skip('log lines carry a timestamp and a recognisable operation/module tag', async ({ bottomPanel, page }) => {
    // The daemon's INFO logs don't print a level word — see
    // packages/core/src/logger.ts. Assert against the parts that ARE
    // always present: a timestamp and a [Module] tag.
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    const lines = await bottomPanel.getLogLines();
    expect(lines.find(l => /\d{2}:\d{2}:\d{2}/.test(l))).toBeTruthy();
    expect(lines.find(l => /\[[A-Za-z][A-Za-z0-9_-]+\]/.test(l))).toBeTruthy();
  });
});
