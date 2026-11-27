/**
 * Access, on the buyer node: minting an access key shows its secret once,
 * beside the gateway's base URL; after Done, and after a reload, the page
 * lists the key by its label and prefix and never shows the secret again.
 * The secret is the one the gateway takes.
 */
import type { GatewayModels } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { SERVICES, UI, accessKeyIdOf } from '../topology.js';

const LABEL = 'e2e-client';

test.describe('Access', () => {
  test('mints an access key whose secret shows once', async ({ market, page, request }) => {
    const root = await market.open('access', UI.buyer);
    await expect(root).toHaveAttribute('data-state', 'ok');

    await page.getByTestId('mkt-mint-open').click();
    const form = page.getByTestId('mkt-mint-form');
    await form.getByTestId('mkt-mint-label').fill(LABEL);
    await form.getByTestId('mkt-mint-budget').fill('0.5');
    await form.getByTestId('mkt-mint').click();

    const once = page.getByTestId('mkt-key-once');
    await expect(once).toContainText('Shown once. Store it now.');
    const snippet = await once.getByTestId('mkt-key-plaintext').innerText();
    const secret = /api_key\s*=\s*"(dkgmk_[0-9a-f]{48})"/.exec(snippet)?.[1];
    expect(secret, `the snippet names the secret: ${snippet}`).toBeDefined();
    expect(snippet).toContain(`base_url = "${new URL(UI.buyer).origin}/api/marketplace/v1"`);
    // The id the node gives the key, which names its row: see ACCESS_KEY_ID_HEX.
    const keyId = accessKeyIdOf(secret!);

    // The key is listed by its label and prefix while the secret is still on show…
    const row = page.getByTestId(`mkt-key-${keyId}`);
    await expect(row).toContainText(LABEL);
    await expect(row).toContainText(`${keyId}…`);
    await expect(row).toContainText('0 of 0.5 TRAC spent · 0.5 TRAC left');

    // …and once Done is pressed the secret is gone from the page, for good.
    await once.getByTestId('mkt-key-done').click();
    await expect(once).toHaveCount(0);
    await expect(page.getByText(secret!)).toHaveCount(0);
    await market.reload('access');
    await expect(page.getByTestId(`mkt-key-${keyId}`)).toContainText(LABEL);
    expect(await page.content()).not.toContain(secret!);

    // The gateway takes the secret, and lists the services this epoch's subscription funds.
    const models = await request.get(new URL('/api/marketplace/v1/models', UI.buyer).toString(), { headers: { Authorization: `Bearer ${secret}` } });
    expect(models.status()).toBe(200);
    const listed = ((await models.json()) as GatewayModels).data.map((m) => m.service_id).sort();
    expect(listed).toEqual(SERVICES.map((s) => s.serviceId).sort());
  });
});
