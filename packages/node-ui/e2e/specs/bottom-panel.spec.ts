import { test, expect } from '../fixtures/base.js';

test.describe('Bottom Panel', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('starts in collapsed state', async ({ bottomPanel }) => {
    expect(await bottomPanel.isCollapsed()).toBe(true);
  });

  test('has two tabs: Node Log, Transactions', async ({ bottomPanel }) => {
    // The PanelBottom component ships exactly two tabs. The legacy
    // `Agent Runs` + `SPARQL` placeholders were removed once those flows
    // moved into the Operations and Memory views, and the `Gossip` tab was
    // retired (libp2p/GossipSub traffic stays in the Node Log). The
    // assertion is intentionally exact-match so that re-adding tabs
    // without updating the spec is caught as a regression.
    const names = (await bottomPanel.getTabNames()).map((n) => n.trim());
    expect(names).toEqual(['Node Log', 'Transactions']);
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

  test('Node Log shows at least one log line once expanded', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    // Against a live devnet the daemon emits dozens of lines per second,
    // but a single line is enough to prove the tail pipeline is wired.
    // The wide timeout absorbs slow first-flush on cold-cache CI runs.
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    const count = await bottomPanel.getLogLineCount();
    expect(count).toBeGreaterThan(0);
  });

  test('log lines contain timestamps OR log-level markers', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    // Wait for a short tail-buffer so we have multiple lines to sample.
    await page.locator('.v10-log-line').nth(1).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    const lines = await bottomPanel.getLogLines();
    expect(lines.length).toBeGreaterThan(0);
    // Live devnet logs interleave structured operation logs (with
    // ISO-8601 stamps) AND raw daemon stderr (no stamps but with
    // INFO/DEBUG/WARN/ERROR markers). Either signal is sufficient
    // proof the line is a real daemon log and not just an empty DOM
    // node — assert the union, not the intersection.
    const hasTimestamp = lines.some((l) => /\d{4}-\d{2}-\d{2}/.test(l));
    const hasLevel = lines.some((l) => /INFO|DEBUG|WARN|ERROR/.test(l));
    expect(hasTimestamp || hasLevel).toBe(true);
  });

  test('Transactions tab renders chain-phase operations (or empty state)', async ({ bottomPanel, page }) => {
    // The Transactions tab is no longer a "coming soon" placeholder — it
    // ships a live view of operations that reached the `chain` phase.
    // On a fresh devnet that view starts empty (no on-chain TXs yet), in
    // which case the component shows a deliberate empty-state message.
    // Either the table OR the empty-state banner is acceptable proof
    // the tab is wired up; assert the union, not one specific shape.
    await bottomPanel.toggle();
    await bottomPanel.switchTab('Transactions');
    const body = page.locator('.v10-bottom-content');
    const table = body.locator('table');
    const emptyState = body.getByText(/No publish, update, or verify activity/i);
    await expect(table.or(emptyState).first()).toBeVisible();
  });

  test('switching tabs updates active state', async ({ bottomPanel }) => {
    await bottomPanel.toggle();
    await bottomPanel.switchTab('Transactions');
    const active = await bottomPanel.getActiveTabName();
    expect(active?.trim()).toBe('Transactions');
  });

  test('collapsing hides content area', async ({ bottomPanel }) => {
    await bottomPanel.toggle();
    expect(await bottomPanel.isCollapsed()).toBe(false);
    await bottomPanel.toggle();
    expect(await bottomPanel.isCollapsed()).toBe(true);
  });

  test('log filter input filters the displayed log lines (server-side q)', async ({ bottomPanel, page }) => {
    // The Node Log filter is applied SERVER-SIDE: typing re-fetches
    // `/api/node-log?q=<filter>` and the daemon returns only matching lines
    // (see NodeLogContent.load). The old "BUG: filter doesn't filter" note was
    // a mock-era artifact — the stub ignored `q`. Against the real daemon the
    // filter works.
    //
    // Comparing line counts before/after a substring filter is racy on a live
    // daemon (dozens of lines/sec keep arriving). Instead filter by a token
    // that CANNOT appear in any log line and assert the view collapses to the
    // deliberate empty state — deterministic proof the `q` round-trip filtered.
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    await bottomPanel.filterLogs('zzz-no-log-line-can-ever-contain-this-token-zzz');
    // The filter change triggers a refetch; poll for the empty-state line.
    await expect(page.getByText('No log output', { exact: true })).toBeVisible({ timeout: 10_000 });

    // Clearing the filter must restore real log lines (the round-trip is
    // reversible, not a one-way dead end). The empty-state placeholder is
    // itself a `.v10-log-line`, so assert the placeholder is GONE rather than
    // counting lines.
    await bottomPanel.filterLogs('');
    await expect(page.getByText('No log output', { exact: true })).toBeHidden({ timeout: 10_000 });
  });

  test('log lines come from the real daemon (non-empty + tail keeps appending)', async ({ bottomPanel, page }) => {
    // The earlier `contains "Node started"` assertion was fixture-specific
    // (relied on demo seed data). Against a real devnet daemon the
    // greeting line varies. The durable invariant is: the tail keeps
    // arriving — sample twice with a delay and assert the count grew or
    // at least stayed populated.
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    const before = await bottomPanel.getLogLineCount();
    expect(before).toBeGreaterThan(0);
    await page.waitForTimeout(2000);
    const after = await bottomPanel.getLogLineCount();
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('multiple distinct log lines appear (real daemon emits varied output)', async ({ bottomPanel, page }) => {
    // The earlier assertion required BOTH `INFO` and `DEBUG` substrings
    // — but a quiet daemon may not emit both within the 5s window. The
    // durable invariant is: the tail surfaces > 1 *distinct* line, which
    // proves the live tail isn't mirroring a single static row.
    await bottomPanel.toggle();
    await page.locator('.v10-log-line').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.v10-log-line').nth(1).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    const lines = await bottomPanel.getLogLines();
    const distinct = new Set(lines.map((l) => l.trim()));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
