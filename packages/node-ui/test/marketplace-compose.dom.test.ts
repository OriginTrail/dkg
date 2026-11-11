// @vitest-environment happy-dom
// Composing a plan and funding it: plan edits, onboarding, a plan that fails
// to save, epoch boundaries, and dry runs that hold the confirmation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceDraftStore } from '../src/ui/marketplace/draftStore.js';
import { FIXTURE_IDS, fixtureFetch } from '../src/ui/marketplace/api/fixtures.js';
import { MISSING_COPY, byTestId, click, flush, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';
import { boundaryNode, editedNode, fundings, holdDryRuns, json, plans, recordWrites, waitUntil, withCaps, type Json } from './helpers/marketplace-nodes.js';

/** A query service no seller offers this epoch, so the catalog lacks it. */
const UNLISTED = `0x${'51'.repeat(32)}`;

/** The fixture node with UNLISTED in its plan, pinned to seller B, keeping each write and each plan it answered. */
function planWithUnlisted(): { writes: Array<{ method: string; url: string; body: unknown }>; reads: Json[] } {
  const reads: Json[] = [];
  const writes = editedNode('active', (method, url, body) => {
    if (method !== 'GET' || url !== '/api/marketplace/plan') return;
    (body.services as Json[]).push({
      serviceId: UNLISTED, serviceClass: 'query', value: '400000000000000000', valueTrac: '0.4', maxPricePerUnit: '2000000000000', maxPricePerUnitTrac: '0.000002', pinnedSeller: FIXTURE_IDS.sellerB,
    });
    reads.push(JSON.parse(JSON.stringify(body)) as Json);
  });
  return { writes, reads };
}

const savedPlans = (writes: Array<{ method: string; url: string; body: unknown }>) => writes.filter((w) => w.method === 'PUT' && w.url === '/api/marketplace/plan');

describe('marketplace plan composition and funding', () => {
  afterEach(async () => {
    await unmountAll();
    useMarketplaceDraftStore.setState({ ask: null });
  });

  it('saves an edit to one line of the plan with every other cap unchanged to the wei', async () => {
    const writes = editedNode('active', withCaps({ [FIXTURE_IDS.qwen14b]: '123456000000', [FIXTURE_IDS.qwen7b]: '10' }));
    const c = await render(plans());
    await waitForText(c, 'Epoch 665 is funded');
    await click(byTestId(c, 'mkt-change-plan'));
    expect((byTestId(c, `mkt-cap-${FIXTURE_IDS.qwen14b}`) as HTMLInputElement).value).toBe('0.123456');
    expect((byTestId(c, `mkt-cap-${FIXTURE_IDS.qwen7b}`) as HTMLInputElement).value).toBe('0.00000000001');
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.llama8b}`), '0.75');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await flush(50);
    const saved = writes.filter((w) => w.method === 'PUT' && w.url === '/api/marketplace/plan');
    expect(saved).toHaveLength(1);
    const services = (saved[0].body as { services: Array<{ serviceId: string; value: string; maxPricePerUnit: string }> }).services;
    expect(Object.fromEntries(services.map((s) => [s.serviceId, s.maxPricePerUnit]))).toEqual({
      [FIXTURE_IDS.qwen14b]: '123456000000', [FIXTURE_IDS.qwen7b]: '10', [FIXTURE_IDS.llama8b]: '1200000000000',
    });
    expect(services.find((s) => s.serviceId === FIXTURE_IDS.llama8b)?.value).toBe('750000000000000000');
  });

  it('saves an edit to the plan with a query service the catalog lacks this epoch as it was, its class included', async () => {
    const { writes } = planWithUnlisted();
    const c = await render(plans());
    await waitForText(c, 'Epoch 665 is funded');
    await click(byTestId(c, 'mkt-change-plan'));
    // No seller offers it this epoch: the composer shows it as unavailable, with its saved terms.
    expect(byTestId(c, `mkt-line-${UNLISTED}`)?.textContent).toContain('Unavailable: no seller offers it this epoch');
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.llama8b}`), '0.75');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await flush(50);
    const saved = savedPlans(writes);
    expect(saved).toHaveLength(1);
    const services = (saved[0].body as { services: Json[] }).services;
    expect(services.find((s) => s.serviceId === UNLISTED)).toEqual({
      serviceId: UNLISTED, serviceClass: 'query', value: '400000000000000000', maxPricePerUnit: '2000000000000', pinnedSeller: FIXTURE_IDS.sellerB,
    });
    expect(services.filter((s) => s.serviceId !== UNLISTED).map((s) => s.serviceClass)).toEqual(['inference', 'inference', 'inference']);
  });

  it('removes a service the catalog lacks this epoch from the plan, saving every other term as it was read', async () => {
    const { writes, reads } = planWithUnlisted();
    const c = await render(plans());
    await waitForText(c, 'Epoch 665 is funded');
    await click(byTestId(c, 'mkt-change-plan'));
    const row = byTestId(c, `mkt-line-${UNLISTED}`);
    expect(row?.textContent).toContain('Unavailable: no seller offers it this epoch');
    expect(row?.textContent).toContain('Pinned to seller 31');
    expect((byTestId(c, `mkt-value-${UNLISTED}`) as HTMLInputElement).value).toBe('0.4');
    expect((byTestId(c, `mkt-cap-${UNLISTED}`) as HTMLInputElement).value).toBe('2');
    await click(byTestId(c, `mkt-remove-${UNLISTED}`));
    expect(byTestId(c, `mkt-line-${UNLISTED}`)).toBeNull();
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await flush(50);
    const saved = savedPlans(writes);
    expect(saved).toHaveLength(1);
    const read = reads[0] as unknown as { services: Json[]; source: Json; renew: boolean; renewUntilEpoch?: number };
    expect(read.services.map((s) => s.serviceId)).toContain(UNLISTED);
    expect(saved[0].body).toEqual({
      services: read.services.filter((s) => s.serviceId !== UNLISTED).map((s) => ({
        serviceId: s.serviceId, serviceClass: s.serviceClass, value: s.value, maxPricePerUnit: s.maxPricePerUnit, ...(s.pinnedSeller !== undefined ? { pinnedSeller: s.pinnedSeller } : {}),
      })),
      source: read.source.kind === 'account' ? { kind: 'account', accountId: read.source.accountId } : { kind: 'wallet' },
      renew: read.renew,
      ...(read.renewUntilEpoch !== undefined ? { renewUntilEpoch: read.renewUntilEpoch } : {}),
    });
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('saves edits to the budget and cap of a service the catalog lacks this epoch, its class and seller as they were', async () => {
    const { writes } = planWithUnlisted();
    const c = await render(plans());
    await waitForText(c, 'Epoch 665 is funded');
    await click(byTestId(c, 'mkt-change-plan'));
    await type(byTestId(c, `mkt-value-${UNLISTED}`), '0.25');
    await type(byTestId(c, `mkt-cap-${UNLISTED}`), '3');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await flush(50);
    const saved = savedPlans(writes);
    expect(saved).toHaveLength(1);
    const services = (saved[0].body as { services: Json[] }).services;
    expect(services).toHaveLength(4);
    expect(services.find((s) => s.serviceId === UNLISTED)).toEqual({
      serviceId: UNLISTED, serviceClass: 'query', value: '250000000000000000', maxPricePerUnit: '3000000000000', pinnedSeller: FIXTURE_IDS.sellerB,
    });
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
    expect(writes[1].body).toEqual({ epoch: 664, source: { kind: 'account', accountId: '7' }, services: [{ serviceId: FIXTURE_IDS.qwen14b, serviceClass: 'inference', value: '2000000000000000000', maxPricePerUnit: '700000000000' }] });
    expect(writes[2].body).toMatchObject({ renew: true, renewUntilEpoch: 670 });
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('sends a funding once: when the plan fails to save, a retry saves the plan alone', async () => {
    const sent: string[] = [];
    const node = fixtureFetch('none');
    let failPlan = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') sent.push(`${method} ${String(input)}`);
      if (method === 'PUT' && failPlan) {
        failPlan = false;
        return new Response(JSON.stringify({ error: 'disk full', code: 'Error', retryable: false }), { status: 500 });
      }
      return node(input, init);
    });
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'The epoch is funded, but the plan was not saved');
    expect(byTestId(c, 'mkt-key-step')).toBeTruthy();
    await click(byTestId(c, 'mkt-plan-retry'));
    await flush(50);
    expect(byTestId(c, 'mkt-plan-unsaved')).toBeNull();
    expect(sent.filter((x) => x === 'POST /api/marketplace/subscriptions')).toHaveLength(1);
    expect(sent.filter((x) => x === 'PUT /api/marketplace/plan')).toHaveLength(2);
  });

  it('saves a changed plan alone: a failed save stays on the confirmation, and nothing is funded', async () => {
    const sent: string[] = [];
    const node = fixtureFetch('active');
    let failPlan = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') sent.push(`${method} ${String(input)}`);
      if (method === 'PUT' && failPlan) {
        failPlan = false;
        return json({ error: 'disk full', code: 'Error', retryable: false }, 500);
      }
      return node(input, init);
    });
    const c = await render(plans());
    await waitForText(c, 'Epoch 665 is funded');
    await click(byTestId(c, 'mkt-change-plan'));
    // A changed plan: read back after the failed save, the node still holds the one before.
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.llama8b}`), '0.75');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-confirm-gate')?.textContent).toContain('One confirmation — the plan');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Something went wrong');
    expect(byTestId(c, 'mkt-fund-flow')?.getAttribute('data-phase')).toBe('confirm');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitUntil(() => byTestId(c, 'mkt-fund-flow') === null, 'the plan flow to close');
    expect(sent).toEqual(['PUT /api/marketplace/plan', 'PUT /api/marketplace/plan']);
  });

  it('funds the epoch its dry run answered for when the next epoch starts before Confirm', async () => {
    const node = boundaryNode();
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await click(byTestId(c, 'mkt-epoch-next'));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 665');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-source')?.textContent).toContain('Epoch 665, paid from the buyer wallet');
    // Epoch 665 starts: 'next' would now be 666.
    node.pass();
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 665 is funded with 1 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { epoch: unknown }).epoch)).toEqual([665]);
    expect(node.writes.filter((w) => w.method === 'PUT' && w.url === '/api/marketplace/plan')).toHaveLength(1);
  });

  it('sends nothing more when the epoch a confirmation shows has ended, and funds the open one after a fresh dry run', async () => {
    const node = boundaryNode();
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-source')?.textContent).toContain('Epoch 664');
    // Epoch 664 ends: 'current' would now be 665, which the confirmation does not show.
    node.pass();
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'That epoch can no longer be funded — go back for a fresh dry run');
    expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('InvalidFundingRequest');
    expect(byTestId(c, 'mkt-funded')).toBeNull();
    expect(fundings(node.writes).map((w) => (w.body as { epoch: unknown }).epoch)).toEqual([664]);
    expect(node.writes.some((w) => w.method === 'PUT')).toBe(false);

    await click(byTestId(c, 'mkt-gate-cancel'));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 665');
    await click(byTestId(c, 'mkt-compose-continue'));
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 665 is funded with 1 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { epoch: unknown }).epoch)).toEqual([664, 665]);
  });

  it('holds Continue while a changed budget\'s dry run is pending, and funds only what the shown dry run answered', async () => {
    const node = holdDryRuns('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await click(byTestId(c, 'mkt-source-7'));
    await flush(300);
    await waitForText(c, 'Costs 0.9 TRAC from account 7 for epoch 664: 1 TRAC of service, 10% off');
    const continueBtn = () => byTestId(c, 'mkt-compose-continue') as HTMLButtonElement;
    expect(continueBtn().disabled).toBe(false);

    // The budget changes to 50 TRAC; its dry run stays pending.
    node.hold = true;
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen14b}`), '50');
    await flush(300);
    expect(node.waiting).toBe(1);
    expect(byTestId(c, 'mkt-preview')?.textContent).toContain('1 TRAC of service');
    expect(continueBtn().disabled).toBe(true);
    await click(continueBtn());
    expect(byTestId(c, 'mkt-fund-flow')?.getAttribute('data-phase')).toBe('compose');
    expect(byTestId(c, 'mkt-confirm-gate')).toBeNull();
    expect(byTestId(c, 'mkt-gate-confirm')).toBeNull();
    expect(fundings(node.writes)).toEqual([]);

    // The matching dry run comes back: it is shown, and only now can it be accepted.
    node.hold = false;
    node.release();
    await waitForText(c, 'Costs 45 TRAC from account 7 for epoch 664: 50 TRAC of service, 10% off');
    expect(fundings(node.writes)).toEqual([]);
    await click(continueBtn());
    expect(byTestId(c, 'mkt-gate-total')?.textContent).toContain('50 TRAC of service · costs 45 TRAC');
    expect(byTestId(c, 'mkt-gate-lines')?.textContent).toContain('50 TRAC');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 50 TRAC');
    const sent = fundings(node.writes);
    expect(sent.map((w) => w.body)).toEqual([{ epoch: 664, source: { kind: 'account', accountId: '7' }, services: [{ serviceId: FIXTURE_IDS.qwen14b, serviceClass: 'inference', value: '50000000000000000000', maxPricePerUnit: '700000000000' }] }]);
    const lastDryRun = node.writes.map((w) => w.url).lastIndexOf('/api/marketplace/subscriptions/preview');
    expect((node.writes[lastDryRun].body as { services: Array<{ value: string }> }).services[0].value).toBe('50000000000000000000');
    expect(node.writes.indexOf(sent[0])).toBeGreaterThan(lastDryRun);
  });

  it('holds Continue while a changed source\'s dry run is pending, and confirms that source', async () => {
    const node = holdDryRuns('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    node.hold = true;
    await click(byTestId(c, 'mkt-source-7'));
    await flush(300);
    expect(node.waiting).toBe(1);
    expect(byTestId(c, 'mkt-preview')?.textContent).toContain('from the buyer wallet');
    expect((byTestId(c, 'mkt-compose-continue') as HTMLButtonElement).disabled).toBe(true);
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-confirm-gate')).toBeNull();
    node.hold = false;
    node.release();
    await waitForText(c, 'Costs 0.9 TRAC from account 7 for epoch 664');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-source')?.textContent).toContain('account 7');
    expect(byTestId(c, 'mkt-gate-total')?.textContent).toContain('costs 0.9 TRAC');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 1 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { source: unknown }).source)).toEqual([{ kind: 'account', accountId: '7' }]);
  });

  it('drops a late dry run of an earlier budget', async () => {
    const node = holdDryRuns('none');
    const c = await render(plans());
    await waitForText(c, 'Compose your plan');
    node.hold = true;
    await click(byTestId(c, `mkt-pick-${FIXTURE_IDS.qwen14b}`));
    await flush(300);
    await type(byTestId(c, `mkt-value-${FIXTURE_IDS.qwen14b}`), '2');
    await flush(300);
    expect(node.waiting).toBe(2);
    // The 2 TRAC answer arrives first, then the 1 TRAC one, late.
    node.hold = false;
    node.release(true);
    await waitForText(c, 'Costs 2 TRAC from the buyer wallet for epoch 664');
    await flush(50);
    expect(byTestId(c, 'mkt-preview')?.textContent).toContain('Costs 2 TRAC');
    await click(byTestId(c, 'mkt-compose-continue'));
    expect(byTestId(c, 'mkt-gate-total')?.textContent).toContain('2 TRAC of service · costs 2 TRAC');
    await click(byTestId(c, 'mkt-gate-confirm'));
    await waitForText(c, 'Epoch 664 is funded with 2 TRAC');
    expect(fundings(node.writes).map((w) => (w.body as { services: Array<{ value: string }> }).services[0].value)).toEqual(['2000000000000000000']);
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
});
