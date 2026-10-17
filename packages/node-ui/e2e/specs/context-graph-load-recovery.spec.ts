import { test, expect } from '../fixtures/base.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

// Healthy reads go to the real devnet. Inject only a temporary failed HTTP
// response, then remove it and verify that Retry restores actual seeded data.
for (const endpoint of ['/api/context-graph/list', '/api/agent/identity']) {
  test(`context graph inventory recovers from unavailable ${endpoint}`, async ({ page, shell, dashboard }) => {
    const route = `**${endpoint}`;
    await page.route(route, intercepted => intercepted.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test outage' }),
    }));
    await shell.goto();
    const dashboardRoot = page.locator('.v10-dashboard');
    const sidebar = page.locator('.v10-panel-left');
    await expect(dashboardRoot.getByRole('alert')).toContainText('could not be loaded');
    await expect(sidebar.getByRole('alert')).toContainText('unavailable');
    await expect(sidebar).not.toContainText('No context graphs yet');
    await expect(dashboardRoot).not.toContainText('No context graphs yet');
    const count = dashboardRoot.locator('.stat-card').filter({ hasText: 'My Context Graphs' }).locator('.stat-value');
    await expect(count).not.toHaveText('0');

    await page.unroute(route);
    await dashboardRoot.getByRole('button', { name: 'Retry', exact: true }).click();
    await sidebar.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dashboardRoot.getByRole('alert')).toHaveCount(0);
    await expect(sidebar.getByRole('alert')).toHaveCount(0);
    await dashboard.waitForCgRowsLoaded();
    await expect(dashboard.cgRows.filter({ hasText: PRIMARY_CG })).toBeVisible();
    await expect(sidebar).toContainText(PRIMARY_CG);
  });
}
