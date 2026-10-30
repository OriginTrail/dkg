import { test, expect } from '../fixtures/base.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

test('a public subscriber is browseable without claiming agent membership', async ({ page, shell, leftPanel }) => {
  await shell.goto();
  const token = await page.evaluate(async () => {
    const response = await fetch('/api/agent/register', { method: 'POST',
      headers: { Authorization: `Bearer ${window.__DKG_TOKEN__}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `ui-public-viewer-${crypto.randomUUID()}`, framework: 'ui-regression' }),
    });
    if (!response.ok) throw new Error(`Agent registration failed: ${response.status}`);
    return (await response.json()).authToken as string;
  });
  expect(token).toBeTruthy();
  // All reads still reach the real daemon; use the new non-member agent's
  // credentials instead of the operator credential embedded by local Vite.
  await page.route('**/api/**', route => route.continue({
    headers: { ...route.request().headers(), authorization: `Bearer ${token}` },
  }));
  const listResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context-graph/list' && response.ok());
  await page.reload();
  const list = await (await listResponse).json();
  const graph = list.contextGraphs.find((cg: { id: string }) => cg.id === PRIMARY_CG);
  expect(graph).toMatchObject({ accessPolicy: 'public', subscribed: true, callerInvolved: false });
  await leftPanel.switchToMode('oracle');
  await leftPanel.clickProject(PRIMARY_CG);
  const role = page.locator('.v10-po-identity-pair').filter({ hasText: 'Your role:' }).locator('.v10-po-badge');
  await expect(role).toHaveText('Public subscriber');
  await expect(role).toHaveAttribute('data-role', 'viewer');
  await expect(role).toHaveAttribute('title', /public access is separate from membership/);
});
