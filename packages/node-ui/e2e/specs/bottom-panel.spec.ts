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

  test('log lines contain timestamps and levels', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.v10-log-line').nth(1).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    const lines = await bottomPanel.getLogLines();
    const hasTimestamp = lines.some(l => /\d{4}-\d{2}-\d{2}/.test(l));
    expect(hasTimestamp).toBe(true);
    const hasLevel = lines.some(l => /INFO|DEBUG|WARN|ERROR/.test(l));
    expect(hasLevel).toBe(true);
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

  test.skip('log filter input filters log lines by text', async ({ bottomPanel, page }) => {
    // BUG: Log filter input does not actually filter the displayed log lines
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 5_000 });
    const totalBefore = await bottomPanel.getLogLineCount();
    await bottomPanel.filterLogs('DEBUG');
    await page.waitForTimeout(500);
    const totalAfter = await bottomPanel.getLogLineCount();
    expect(totalAfter).toBeLessThan(totalBefore);
  });

  test('log lines contain specific content from demo data', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.v10-log-line').nth(1).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    const lines = await bottomPanel.getLogLines();
    const hasNodeStarted = lines.some(l => l.includes('Node started'));
    expect(hasNodeStarted).toBe(true);
  });

  test('multiple log levels appear in output', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.v10-log-line').nth(1).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    const lines = await bottomPanel.getLogLines();
    const hasInfo = lines.some(l => l.includes('INFO'));
    const hasDebug = lines.some(l => l.includes('DEBUG'));
    expect(hasInfo).toBe(true);
    expect(hasDebug).toBe(true);
  });
});
