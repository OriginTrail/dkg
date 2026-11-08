// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlansView } from '../src/ui/marketplace/views/PlansView.js';
import { FIXTURE_IDS, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { MISSING_COPY, byTestId, click, flush, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';

const plans = () => React.createElement(PlansView);

/** The fixture node, keeping what each write sent. */
function recordWrites(scenario: 'active' | 'none'): Array<{ method: string; url: string; body: unknown }> {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch(scenario);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push({ method: init.method, url: String(input), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return node(input, init);
  });
  return writes;
}

describe('marketplace Plans', () => {
  afterEach(unmountAll);

  it('shows this epoch\'s budgets as landed, held and left, with the soft ceiling\'s fork', async () => {
    useFixtureNode('active');
    const c = await render(plans());
    await waitForText(c, 'Epoch 664: 27% of its value landed, 3% held');
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('active');
    const qwen = byTestId(c, `mkt-meter-${FIXTURE_IDS.qwen14b}`);
    expect(qwen?.textContent).toContain('0.72 landed · 0.12 held · 2.16 left of 3 TRAC');
    expect(qwen?.querySelectorAll('.mkt-bar i').length).toBe(2);
    expect(byTestId(c, `mkt-meter-${FIXTURE_IDS.llama8b}`)?.getAttribute('data-state')).toBe('ceiling');
    expect(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`)).toBeTruthy();
    expect(byTestId(c, 'mkt-next-epoch')?.textContent).toContain('Epoch 665 is funded');
    expect(byTestId(c, `mkt-addon-row-${FIXTURE_IDS.mistral24b}`)).toBeTruthy();
    await waitForText(c, 'So far: this node holds 19 receipts · 200 landed, 199 matched');
    expect(byTestId(c, 'mkt-activity')?.textContent).toContain('dkgmk_1a2b3c4d');
    expect(byTestId(c, 'mkt-treasury')?.textContent).toContain('This node may spend up to 20 TRAC per epoch');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('tops up a budget from the subscription\'s own source', async () => {
    const writes = recordWrites('active');
    const c = await render(plans());
    await waitForText(c, 'This budget is at its soft ceiling');
    await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
    expect(byTestId(c, 'mkt-topup')?.textContent).toContain('Top up llama-3.1-8b-instruct for epoch 664');
    await type(byTestId(c, 'mkt-topup-amount'), '0.5');
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up');
    expect(writes).toEqual([{
      method: 'POST', url: `/api/marketplace/subscriptions/${'0x' + '98'.repeat(32)}/top-up`,
      body: { services: [{ serviceId: FIXTURE_IDS.llama8b, serviceClass: 'inference', value: '500000000000000000', maxPricePerUnit: '1200000000000' }] },
    }]);
  });

  it('walks a node that never subscribed through compose, one confirmation and a key', async () => {
    const writes = recordWrites('none');
    const c = await render(plans());
    await waitForText(c, 'Three steps to your first answer');
    expect(byTestId(c, 'mkt-treasury')).toBeTruthy();
    expect(byTestId(c, 'mkt-progress-steps')?.getAttribute('data-step')).toBe('2');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    expect(byTestId(c, `mkt-units-${FIXTURE_IDS.qwen14b}`)?.textContent).toBe('≈ 1.7M tokens at 0.6 µTRAC, the best price under the cap');
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen14b}`), '2');
    await click(byTestId(c, 'mkt-source-7'));
    await flush(300);
    await waitForText(c, 'Costs 1.8 TRAC from account 7 for epoch 664: 2 TRAC of service, 10% off');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-confirm-gate')?.textContent).toContain('2 TRAC of service · costs 1.8 TRAC ~$0.50');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 2 TRAC');
    expect(byTestId(c, 'mkt-progress-steps')?.getAttribute('data-step')).toBe('3');
    await click(byTestId(c, 'mkt-mint'));
    await waitForText(c, '/api/marketplace/v1');
    expect(byTestId(c, 'mkt-key-plaintext')?.textContent).toContain('dkgmk_0123456789abcdef');
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /api/marketplace/subscriptions/preview', 'POST /api/marketplace/subscriptions', 'PUT /api/marketplace/plan', 'POST /api/marketplace/keys',
    ]);
    expect(writes[1].body).toEqual({ epoch: 'current', source: { kind: 'account', accountId: '7' }, services: [{ serviceId: FIXTURE_IDS.qwen14b, serviceClass: 'inference', value: '2000000000000000000', maxPricePerUnit: '700000000000' }] });
    expect(writes[2].body).toMatchObject({ renew: true, renewUntilEpoch: 670 });
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('shows the dry run\'s refusal and holds the confirmation back', async () => {
    useFixtureNode('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen7b}`));
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen7b}`), '50');
    await flush(300);
    await waitForText(c, 'The buyer wallet does not hold enough TRAC');
    expect(byTestId(c, 'mkt-preview')?.getAttribute('data-refusal')).toBe('ERC20InsufficientBalance');
    expect((byTestId(c, 'mkt-compose-continue') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers to fund this epoch when the plan stopped renewing, with last epoch\'s final reconciliation', async () => {
    useFixtureNode('ended');
    const c = await render(plans());
    await waitForText(c, 'No subscription funds epoch 664');
    expect(c.textContent).toContain('The plan does not renew');
    await waitForText(c, 'Final: 200 receipts landed, 199 matched this node\'s · 0 held');
    await click(byTestId(c, 'mkt-new-period'));
    expect(byTestId(c, 'mkt-composer')).toBeTruthy();
    expect(c.querySelectorAll('[data-testid^="mkt-value-"]').length).toBe(3);
  });

  it('says when the marketplace is off', async () => {
    useFixtureNode('off');
    const c = await render(plans());
    await waitForText(c, 'The marketplace is off on this node');
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('off');
  });
});
