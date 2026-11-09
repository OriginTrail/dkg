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

/** The fixture node, keeping each write, with dry runs held back while `hold` is on until `release()`. */
function holdDryRuns(scenario: 'active' | 'none') {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const held: Array<{ body: unknown; answer: () => void }> = [];
  const node = fixtureFetch(scenario);
  const control = {
    writes,
    hold: false,
    /** How many dry runs are waiting. */
    get waiting() { return held.length; },
    /** Answer the held dry runs, newest first when `newestFirst`. */
    release(newestFirst = false) {
      const out = held.splice(0);
      for (const h of newestFirst ? out.reverse() : out) h.answer();
    },
  };
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method !== 'GET') writes.push({ method, url: String(input), body });
    if (control.hold && String(input).endsWith('/subscriptions/preview')) {
      return new Promise<Response>((resolve) => { held.push({ body, answer: () => resolve(node(input, init)) }); });
    }
    return node(input, init);
  });
  return control;
}

const fundings = (writes: Array<{ method: string; url: string }>) => writes.filter((w) => w.method === 'POST' && w.url === '/api/marketplace/subscriptions');

type Json = Record<string, unknown>;

/** The fixture node with each answer passed through `edit` first, keeping each write. */
function editedNode(scenario: 'active' | 'none', edit: (method: string, url: string, body: Json) => void): Array<{ method: string; url: string; body: unknown }> {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const node = fixtureFetch(scenario);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ method, url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const res = await node(input, init);
    const body = await res.json() as Json;
    edit(method, String(input), body);
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  });
  return writes;
}

/** Caps in wei per unit, by service, on this node's subscriptions and plan. */
function withCaps(caps: Record<string, string>) {
  const cap = (x: Json) => { if (typeof x.serviceId === 'string' && caps[x.serviceId]) { x.maxPricePerUnit = caps[x.serviceId]; x.maxPricePerUnitTrac = '0.0'; } };
  return (method: string, url: string, body: Json) => {
    if (method !== 'GET') return;
    if (url.startsWith('/api/marketplace/subscriptions')) for (const s of (body.subscriptions as Json[]) ?? []) for (const b of s.budgets as Json[]) cap(b);
    if (url === '/api/marketplace/plan') for (const s of (body.services as Json[]) ?? []) cap(s);
  };
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
    await click(byTestId(c, 'mkt-recon-663'));
    await waitForText(c, 'Final: 200 receipts landed, 199 matched this node\'s · 0 held');
    expect(byTestId(c, 'mkt-reconciliation')?.getAttribute('data-epoch')).toBe('663');
    expect(byTestId(c, 'mkt-activity')?.textContent).toContain('dkgmk_1a2b3c4d');
    expect(byTestId(c, 'mkt-treasury')?.textContent).toContain('This node may spend up to 20 TRAC per epoch');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('tops up a budget from the subscription\'s own source after the node\'s dry run', async () => {
    const writes = recordWrites('active');
    const c = await render(plans());
    await waitForText(c, 'This budget is at its soft ceiling');
    await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
    expect(byTestId(c, 'mkt-topup')?.textContent).toContain('Top up llama-3.1-8b-instruct for epoch 664');
    await type(byTestId(c, 'mkt-topup-amount'), '50');
    await flush(300);
    await waitForText(c, 'The buyer wallet does not hold enough TRAC');
    expect((byTestId(c, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(true);
    await type(byTestId(c, 'mkt-topup-amount'), '0.5');
    await flush(300);
    await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up');
    const subscription = `/api/marketplace/subscriptions/${'0x' + '98'.repeat(32)}`;
    const services = [{ serviceId: FIXTURE_IDS.llama8b, serviceClass: 'inference', value: '500000000000000000', maxPricePerUnit: '1200000000000' }];
    expect(writes.filter((w) => w.url === `${subscription}/top-up`)).toEqual([{ method: 'POST', url: `${subscription}/top-up`, body: { services } }]);
    const dryRuns = writes.filter((w) => w.url === `${subscription}/top-up/preview`);
    expect(dryRuns.at(-1)).toEqual({ method: 'POST', url: `${subscription}/top-up/preview`, body: { services } });
    expect(writes.findIndex((w) => w.url === `${subscription}/top-up`)).toBeGreaterThan(writes.lastIndexOf(dryRuns.at(-1)!));
  });

  for (const cap of ['123456000000', '10']) {
    it(`tops up a budget with its own cap to the wei (${cap} wei per token)`, async () => {
      const writes = editedNode('active', withCaps({ [FIXTURE_IDS.llama8b]: cap }));
      const c = await render(plans());
      await waitForText(c, 'This budget is at its soft ceiling');
      await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
      const capInput = byTestId(c, 'mkt-topup-cap') as HTMLInputElement;
      expect(capInput.disabled).toBe(true);
      expect(capInput.value).toBe(cap === '10' ? '0.00000000001' : '0.123456');
      await type(byTestId(c, 'mkt-topup-amount'), '0.5');
      await flush(300);
      await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up');
      const sentCaps = writes.filter((w) => w.url.includes('/top-up')).map((w) => (w.body as { services: Array<{ maxPricePerUnit: string }> }).services[0].maxPricePerUnit);
      expect(sentCaps.length).toBeGreaterThanOrEqual(2);
      expect(new Set(sentCaps)).toEqual(new Set([cap]));
    });
  }

  it('adds a budget at the dearest seller\'s price to the wei', async () => {
    const price = '3123456789012';
    const writes = editedNode('active', (method, url, body) => {
      if (method !== 'GET' || url !== '/api/marketplace/catalog') return;
      for (const s of body.services as Json[]) {
        if (s.serviceId !== FIXTURE_IDS.mistral24b) continue;
        for (const o of s.offers as Json[]) o.pricePerUnit = price;
        s.priceMin = price; s.priceMax = price;
      }
    });
    const c = await render(plans());
    await waitForText(c, 'Not on your plan yet');
    await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
    expect((byTestId(c, 'mkt-topup-cap') as HTMLInputElement).value).toBe('3.123456789012');
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'topped up');
    expect(writes.filter((w) => w.url.endsWith('/top-up')).map((w) => (w.body as { services: Array<{ maxPricePerUnit: string }> }).services[0].maxPricePerUnit)).toEqual([price]);
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
    expect(sent.map((w) => w.body)).toEqual([{ epoch: 'current', source: { kind: 'account', accountId: '7' }, services: [{ serviceId: FIXTURE_IDS.qwen14b, serviceClass: 'inference', value: '50000000000000000000', maxPricePerUnit: '700000000000' }] }]);
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
