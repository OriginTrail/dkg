/**
 * A Conviction Account buyer, on the buyer node. The node opens an account
 * on the conviction accounts page, committing enough TRAC for a 30% discount.
 * In Plans it then turns the account's service spending on, adds its own
 * buyer wallet to it, and changes the standing plan to pay from it: the next
 * renewal says it will cost the plan's value less the discount, with no
 * refusal. The epoch-close spec then sees that renewal fund the next epoch
 * from the account.
 */
import type { Funding, Plan } from '../../../src/ui/marketplace/api/types.js';
import { test, expect } from '../fixtures.js';
import { epochTimes, nodeOk, readSetup } from '../devnet.js';
import { ACCOUNT, PLAN, UI, tracOf, weiOfTrac } from '../topology.js';

test.describe('A Conviction Account buyer', () => {
  test('opens an account, adds its buyer wallet, and pays its plan from it at the discount', async ({ market, page, shell, conviction }) => {
    test.setTimeout(300_000);
    const { buyer } = readSetup();
    const { epoch } = await epochTimes();
    const planValue = weiOfTrac(PLAN.chatTrac) + weiOfTrac(PLAN.reasonerTrac);
    const cost = (planValue * BigInt(10_000 - ACCOUNT.discountBps)) / 10_000n;

    // The account, opened from the node's own wallet on the conviction accounts page.
    await shell.goto();
    await conviction.open();
    await conviction.createBtn.click();
    await expect(conviction.createModal).toBeVisible();
    await conviction.createModal.getByLabel(/This node's hot wallet/i).check();
    await conviction.createTokensInput.fill(ACCOUNT.committedTrac);
    await expect(conviction.createSubmit).toBeEnabled({ timeout: 30_000 });
    await conviction.createSubmit.click();
    await expect(conviction.createSuccess).toBeVisible({ timeout: 120_000 });
    const accountId = /Account #(\d+)/.exec(await conviction.createSuccess.innerText())?.[1];
    expect(accountId, 'the conviction accounts page names the new account').toBeDefined();

    // Plans: the node owns it, and its service spending is off.
    await market.open('plans', UI.buyer);
    const row = page.getByTestId(`mkt-account-${accountId}`);
    await expect(row).toContainText(`Account ${accountId}`);
    await expect(row).toContainText('owned by this node');
    await expect(row).toHaveAttribute('data-capable', 'false');
    await row.getByTestId(`mkt-spending-${accountId}`).click();
    await expect(row.getByTestId(`mkt-spending-${accountId}`)).toHaveText('Turn service spending off', { timeout: 60_000 });

    // The node's buyer wallet on the account, for 20 TRAC an epoch, long enough to cover the next epoch.
    await row.getByTestId(`mkt-add-buyer-${accountId}`).click();
    const form = row.getByTestId('mkt-limits-form');
    await form.getByTestId('mkt-limit').fill('20');
    await form.getByTestId('mkt-limit-days').fill('90');
    await form.getByTestId('mkt-limits-send').click();
    await expect(row).toHaveAttribute('data-capable', 'true', { timeout: 60_000 });
    await expect(row).toContainText(`can pay for services · ${ACCOUNT.discountBps / 100}% off`);
    await expect(row).toContainText('This node may spend up to 20 TRAC per epoch');
    const funding = await nodeOk<Funding>(buyer.node, 'GET', '/api/marketplace/funding');
    expect(funding.accounts.find((a) => a.accountId === accountId)).toMatchObject({
      ownedByNode: true, serviceCapable: true, discountBps: ACCOUNT.discountBps, grant: { live: true, buyer: funding.buyerWallet.address },
    });

    // The plan, changed to pay from the account: saved alone, for its next renewal to fund.
    await page.getByTestId('mkt-change-plan').click();
    const source = page.getByTestId(`mkt-source-${accountId}`);
    await expect(source).toBeEnabled();
    await expect(source).toHaveText(`Account ${accountId} · ${ACCOUNT.discountBps / 100}% off`);
    await source.click();
    await expect(source).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('mkt-compose-continue').click();
    const gate = page.getByTestId('mkt-confirm-gate');
    await expect(gate).toContainText('One confirmation — the plan');
    await gate.getByTestId('mkt-gate-confirm').click();
    await expect(gate).toHaveCount(0, { timeout: 60_000 });

    const plan = await nodeOk<Plan>(buyer.node, 'GET', '/api/marketplace/plan');
    expect(plan).toMatchObject({ source: { kind: 'account', accountId, discountBps: ACCOUNT.discountBps }, renew: true, next: { epoch: epoch + 1, cost: String(cost) } });
    expect(plan.next?.refusal).toBeUndefined();
    const next = page.getByTestId('mkt-next-epoch');
    await expect(next).toContainText(`Renews epoch ${epoch + 1}`);
    await expect(next).toContainText(`for ${tracOf(cost)} TRAC, from account ${accountId}`);
    await expect(page.getByTestId('mkt-renewal-refusal')).toHaveCount(0);
  });
});
