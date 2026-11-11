// @vitest-environment happy-dom
// Top-ups: what they send, their caps and classes, and their recovery when an
// answer is lost, cut off or refused, across closed forms and reloads.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopUp } from '../src/ui/marketplace/purchase/TopUp.js';
import { useMarketplaceDraftStore } from '../src/ui/marketplace/draftStore.js';
import { FIXTURE_IDS, fixtureWorld } from '../src/ui/marketplace/api/fixtures.js';
import { buttonWithText, byTestId, click, flush, reloadPage, render, type, unmountAll, waitForText } from './helpers/marketplace-render.js';
import { UUID_V4, editedNode, json, keyOf, plans, recordWrites, refusal, topUpLlama, topUpNode, topUps, waitUntil, withCaps, type Json } from './helpers/marketplace-nodes.js';

describe('marketplace top-ups', () => {
  afterEach(async () => {
    await unmountAll();
    useMarketplaceDraftStore.setState({ ask: null });
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
    expect(writes.filter((w) => w.url === `${subscription}/top-up`)).toEqual([{ method: 'POST', url: `${subscription}/top-up`, body: { services, idempotencyKey: expect.stringMatching(UUID_V4) } }]);
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

  it('offers only Retry of the same top-up when its answer is lost and it lands later, and the node adds it once', async () => {
    const node = topUpNode();
    node.first.push('lose');
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    // The answer is lost and the transaction is still on its way: the budget holds what it did.
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up, which may still land.');
    expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
    expect(byTestId(c, 'mkt-topup-unsure')?.getAttribute('data-state')).toBe('missing');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    expect(byTestId(c, 'mkt-preview')).toBeNull();
    expect((byTestId(c, 'mkt-topup-amount') as HTMLInputElement).disabled).toBe(true);

    // Closed and opened again, the form brings back the same top-up, with Retry alone.
    await click(buttonWithText(c, 'Cancel'));
    expect(byTestId(c, 'mkt-topup')).toBeNull();
    await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    expect((byTestId(c, 'mkt-topup-amount') as HTMLInputElement).value).toBe('0.5');
    expect(topUps(node.requests)).toHaveLength(1);

    // The transaction lands: the budget shows it, but only the node's answer ends the top-up.
    await node.land();
    await click(byTestId(c, 'mkt-topup-check'));
    await waitForText(c, 'The budget holds 1 TRAC, up from 0.5: it shows the top-up.');
    expect(byTestId(c, 'mkt-topup-sent')).toBeNull();
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();

    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx 0xc2c2…c2c2');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[0])).toMatch(UUID_V4);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps a top-up whose answer was lost across a reload of the page, and Retry sends it again as it was', async () => {
    const node = topUpNode();
    node.first.push('lose');
    let c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'it does not show the top-up');
    await reloadPage();

    c = await render(plans());
    await waitForText(c, 'This budget is at its soft ceiling');
    await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    // A Retry sent before the transaction lands waits for the node's first answer.
    await click(byTestId(c, 'mkt-topup-retry'));
    expect((byTestId(c, 'mkt-topup-retry') as HTMLButtonElement).disabled).toBe(true);
    node.land();
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  // A top-up whose answer was lost, after it lands and the page reloads: its budget no longer offers a form for it.
  const pastItsForm: Array<[string, string, (c: HTMLElement) => Promise<void>]> = [
    ['a budget at its soft ceiling, past the ceiling once it lands', FIXTURE_IDS.llama8b, async (c) => {
      await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
      await type(byTestId(c, 'mkt-topup-amount'), '0.5');
    }],
    ['a service added to the subscription, off the add-on list once it lands', FIXTURE_IDS.mistral24b, async (c) => {
      await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
    }],
  ];
  for (const [what, serviceId, openForm] of pastItsForm) {
    it(`shows a top-up of ${what}, after a reload, and settles it with its key`, async () => {
      const node = topUpNode();
      node.first.push('lose');
      let c = await render(plans());
      await waitForText(c, 'This budget is at its soft ceiling');
      await openForm(c);
      await flush(300);
      await waitForText(c, 'Costs');
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'it does not show the top-up');
      await node.land();
      await reloadPage();

      c = await render(plans());
      await waitForText(c, 'has no answer from the node yet');
      expect(byTestId(c, `mkt-topup-${serviceId}`)).toBeNull();
      expect(byTestId(c, `mkt-addon-${serviceId}`)).toBeNull();
      await click(byTestId(c, `mkt-topup-open-${serviceId}`));
      await waitForText(c, 'it shows the top-up');
      expect(byTestId(c, `mkt-topup-waiting-${serviceId}`)).toBeNull();
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, 'topped up · tx');
      expect(new Set(topUps(node.requests).map(keyOf)).size).toBe(1);
      expect(node.landings).toBe(1);
      expect(sessionStorage.length).toBe(0);
    });
  }

  it('reads the budget again on request after a lost answer, with Retry alone while it cannot be read', async () => {
    const node = topUpNode();
    node.first.push('lose');
    const c = await topUpLlama();
    node.holdChecks = true;
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'Reading the budget…');
    expect(node.waiting).toBe(1);
    node.failNextRead = true;
    node.release();
    await waitForText(c, 'The budget could not be read.');
    expect(byTestId(c, 'mkt-topup-unsure')?.getAttribute('data-state')).toBe('unread');
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    node.holdChecks = false;
    await node.land();
    await click(byTestId(c, 'mkt-topup-check'));
    await waitForText(c, 'The budget holds 1 TRAC, up from 0.5');
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    expect(topUps(node.requests).map(keyOf)).toEqual([keyOf(topUps(node.requests)[0]), keyOf(topUps(node.requests)[0])]);
    expect(node.landings).toBe(1);
  });

  it('sends the same top-up again on Retry after a failure the node does not explain, never a new one', async () => {
    const node = topUpNode();
    node.first.push(() => json({ error: 'upstream timed out' }, 504));
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up');
    expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('HTTP_504');
    await flush(300);
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    // No dry run opens another top-up meanwhile.
    const sentAt = node.requests.indexOf(topUps(node.requests)[0]);
    expect(node.requests.slice(sentAt + 1).some((r) => r.url.endsWith('/top-up/preview'))).toBe(false);
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
  });

  it('keeps a top-up whose answer is cut off waiting for the node, and Retry sends it again with its key', async () => {
    const node = topUpNode();
    node.first.push('cut');
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    // The transaction landed, but an answer that cannot be read says nothing: the outcome stays unknown.
    await waitForText(c, 'The budget holds 1 TRAC, up from 0.5: it shows the top-up.');
    expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
    expect(byTestId(c, 'mkt-topup-sent')).toBeNull();
    expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
    expect(byTestId(c, 'mkt-topup-unsure')?.querySelector('[data-code="UnreadableAnswer"]')).toBeTruthy();
    expect(sessionStorage.length).toBe(1);
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · tx 0xc2c2…c2c2');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[0])).toMatch(UUID_V4);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  for (const closedRead of ['answers', 'fails'] as const) {
    it(`keeps one top-up, with one key, when another top-up replaces its form while the budget is read before the first send (the read ${closedRead})`, async () => {
      const node = topUpNode();
      const c = await topUpLlama();
      node.holdReads = true;
      await click(byTestId(c, 'mkt-topup-confirm'));
      expect(node.waiting).toBe(1);
      // Another service's top-up replaces the form while that read waits, and then the first one opens again.
      await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
      expect(byTestId(c, 'mkt-topup')?.textContent).toContain('Add mistral-small-24b-instruct to epoch 664');
      await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
      // It comes back as it was confirmed, with Retry alone: no Confirm, so no second key.
      expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
      expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
      expect((byTestId(c, 'mkt-topup-amount') as HTMLInputElement).value).toBe('0.5');
      // The closed form's read comes back first: that form sends nothing and leaves the top-up waiting.
      node.failNextRead = closedRead === 'fails';
      node.holdReads = false;
      node.release();
      await waitForText(c, 'The budget holds 0.5 TRAC: it does not show the top-up');
      await flush(50);
      expect(topUps(node.requests)).toHaveLength(0);
      expect(sessionStorage.length).toBe(1);
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
      const sent = topUps(node.requests);
      expect(sent).toHaveLength(1);
      expect(keyOf(sent[0])).toMatch(UUID_V4);
      expect(node.landings).toBe(1);
      expect(sessionStorage.length).toBe(0);
    });
  }

  it('shows what a top-up added once the node answers it after another service\'s top-up replaced its form, and keeps that form as it is', async () => {
    const node = topUpNode();
    node.first.push('hold');
    const c = await topUpLlama();
    const meter = () => byTestId(c, `mkt-meter-${FIXTURE_IDS.llama8b}`);
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitUntil(() => topUps(node.requests).length === 1, 'the top-up to be sent');
    // Another service's top-up replaces the form while the node has not answered.
    await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
    await type(byTestId(c, 'mkt-topup-amount'), '0.7');
    await flush(300);
    await waitForText(c, 'Costs 0.7 TRAC from the buyer wallet for epoch 664');
    expect(byTestId(c, `mkt-topup-waiting-${FIXTURE_IDS.llama8b}`)).toBeTruthy();
    expect(meter()?.getAttribute('data-state')).toBe('ceiling');
    expect(meter()?.textContent).toContain('left of 0.5 TRAC');
    const asked = node.requests.length;
    await node.land();
    // The answer reaches no form: the budget shows what it added, and offers no other top-up.
    await waitUntil(() => meter()?.getAttribute('data-state') === 'active', 'the budget to show the top-up');
    expect(meter()?.textContent).toContain('left of 1 TRAC');
    expect(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`)).toBeNull();
    expect(byTestId(c, `mkt-topup-waiting-${FIXTURE_IDS.llama8b}`)).toBeNull();
    const reads = node.requests.slice(asked).filter((r) => r.method === 'GET').map((r) => r.url);
    expect(reads).toEqual(expect.arrayContaining(['/api/marketplace/subscriptions', '/api/marketplace/funding']));
    // The replacing form stays as it is: its draft, its dry run and its Confirm, with no new dry run asked for.
    expect(byTestId(c, 'mkt-topup')?.textContent).toContain('Add mistral-small-24b-instruct to epoch 664');
    expect((byTestId(c, 'mkt-topup-amount') as HTMLInputElement).value).toBe('0.7');
    expect(byTestId(c, 'mkt-topup')?.textContent).toContain('Costs 0.7 TRAC');
    expect((byTestId(c, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(false);
    expect(node.requests.slice(asked).some((r) => r.url.endsWith('/top-up/preview'))).toBe(false);
    expect(byTestId(c, 'mkt-topup-sent')).toBeNull();
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('shows what a top-up added as soon as the node answers it, with its form still on show', async () => {
    const node = topUpNode();
    const c = await render(plans());
    await waitForText(c, 'Not on your plan yet');
    await click(byTestId(c, `mkt-addon-${FIXTURE_IDS.mistral24b}`));
    await flush(300);
    await waitForText(c, 'Costs 1 TRAC from the buyer wallet for epoch 664');
    expect(byTestId(c, `mkt-meter-${FIXTURE_IDS.mistral24b}`)).toBeNull();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'mistral-small-24b-instruct topped up');
    // Before Done: the service leaves the add-on list, and its budget shows.
    await waitUntil(() => !byTestId(c, `mkt-addon-row-${FIXTURE_IDS.mistral24b}`), 'the service to leave the add-on list');
    expect(byTestId(c, `mkt-meter-${FIXTURE_IDS.mistral24b}`)?.textContent).toContain('left of 1 TRAC');
    expect(byTestId(c, 'mkt-topup-sent')).toBeTruthy();
    expect(node.landings).toBe(1);
  });

  it('sends nothing, and keeps nothing waiting, when the budget cannot be read before the first send', async () => {
    const node = topUpNode();
    const c = await topUpLlama();
    node.failNextRead = true;
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitUntil(() => byTestId(c, 'mkt-topup')?.getAttribute('data-phase') === 'compose', 'the form to compose again');
    expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe('HTTP_500');
    expect(topUps(node.requests)).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
    expect((byTestId(c, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the first form\'s top-up in a second form of the same budget from the moment it is confirmed, and sends no other', async () => {
    const node = topUpNode();
    const world = fixtureWorld();
    const form = () => render(React.createElement(TopUp, {
      catalog: world.catalog(true), subscription: world.current, serviceId: FIXTURE_IDS.llama8b, onDone: () => undefined, onCancel: () => undefined,
    }));
    const first = await form();
    const second = await form();
    await type(byTestId(first, 'mkt-topup-amount'), '0.5');
    await type(byTestId(second, 'mkt-topup-amount'), '0.7');
    await flush(300);
    await waitForText(first, 'Costs 0.5 TRAC');
    await waitForText(second, 'Costs 0.7 TRAC');
    node.holdReads = true;
    await click(byTestId(first, 'mkt-topup-confirm'));
    // The budget holds the first form's top-up now: the second form shows it as it was confirmed, with nothing of its own to send.
    expect(byTestId(second, 'mkt-topup')?.getAttribute('data-phase')).toBe('sending');
    expect((byTestId(second, 'mkt-topup-amount') as HTMLInputElement).value).toBe('0.5');
    await click(byTestId(second, 'mkt-topup-confirm'));
    expect((byTestId(second, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(true);
    node.holdReads = false;
    node.release();
    await waitForText(first, 'llama-3.1-8b-instruct topped up · tx');
    // Answered, the top-up is over: the second form is back to its own draft, which would be a new top-up.
    await waitUntil(() => byTestId(second, 'mkt-topup')?.getAttribute('data-phase') === 'compose', 'the second form to compose again');
    expect((byTestId(second, 'mkt-topup-amount') as HTMLInputElement).value).toBe('0.7');
    const sent = topUps(node.requests);
    expect(sent).toHaveLength(1);
    expect((sent[0].body as { services: Array<{ value: string }> }).services[0].value).toBe('500000000000000000');
    expect(node.landings).toBe(1);
  });

  const silentOnTheKey: Array<[string, () => Response]> = [
    ['NodeAdminRequired', () => refusal(403, 'NodeAdminRequired')],
    ['IdempotencyKeyReused', () => refusal(409, 'IdempotencyKeyReused')],
    ['Unauthorized', () => json({ error: 'Unauthorized' }, 401)],
    ['HTTP_429', () => json({ error: 'Too many requests' }, 429)],
    // A body the node cannot read is refused before the key is looked at: it says nothing of the first send.
    ['InvalidRequest', () => refusal(400, 'InvalidRequest')],
    // A node too busy to take the request now: try again, with the same key.
    ['budget_busy', () => new Response(JSON.stringify({ error: { code: 'budget_busy', message: 'busy', type: 'marketplace' } }), { status: 429, headers: { 'Retry-After': '5' } })],
    ['gateway_busy', () => new Response(JSON.stringify({ error: { code: 'gateway_busy', message: 'busy', type: 'marketplace' } }), { status: 503, headers: { 'Retry-After': '5' } })],
  ];
  for (const [code, answer] of silentOnTheKey) {
    it(`keeps the top-up unknown when a Retry meets a refusal that says nothing of its key (${code})`, async () => {
      const node = topUpNode();
      node.first.push('lose');
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'it does not show the top-up');
      node.refuseCaller = answer;
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitUntil(() => !!byTestId(c, 'mkt-topup-unsure')?.querySelector(`[data-code="${code}"]`), `the ${code} refusal beside Retry`);
      expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
      expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
      expect(sessionStorage.length).toBe(1);
      node.refuseCaller = null;
      node.land();
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
      expect(new Set(topUps(node.requests).map(keyOf)).size).toBe(1);
      expect(node.landings).toBe(1);
    });
  }

  // Answers that the top-up is still open, whatever their status: the key stays, and so does Retry.
  const stillOpen: Array<[string, () => Response]> = [
    ['TopUpOutcomeUnknown', () => refusal(503, 'TopUpOutcomeUnknown')],
    ['TopUpPending', () => refusal(503, 'TopUpPending')],
    ['TopUpPending', () => refusal(409, 'TopUpPending')],
  ];
  for (const [code, answer] of stillOpen) {
    it(`keeps the top-up unknown, with its key, when a Retry is answered that its outcome is still open (${code} ${answer().status})`, async () => {
      const node = topUpNode();
      node.first.push('lose');
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'it does not show the top-up');
      node.refuseCaller = answer;
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitUntil(() => !!byTestId(c, 'mkt-topup-unsure')?.querySelector(`[data-code="${code}"]`), `the ${code} answer beside Retry`);
      expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('unknown');
      expect(byTestId(c, 'mkt-topup-unsure')?.textContent).toContain('The node cannot tell yet whether this top-up went through');
      expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
      expect(sessionStorage.length).toBe(1);
      node.refuseCaller = null;
      await node.land();
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
      expect(new Set(topUps(node.requests).map(keyOf)).size).toBe(1);
      expect(node.landings).toBe(1);
    });
  }

  // Refusals that nothing was added under the key, and nothing will be: the next top-up is a new one.
  const nothingAdded: Array<[string, () => Response, string]> = [
    ['LimitExceeded', () => refusal(409, 'LimitExceeded', ['maxCostPerEpoch', '1', '2']), 'This costs more than the account\'s limit per epoch'],
    ['TopUpNotSent', () => refusal(409, 'TopUpNotSent', [`0x${'c2'.repeat(32)}`]), 'The top-up was never sent: nothing was added'],
    ['TopUpReverted', () => refusal(409, 'TopUpReverted', [`0x${'c2'.repeat(32)}`]), 'The chain refused the top-up: nothing was added'],
  ];
  for (const [code, answer, words] of nothingAdded) {
    it(`ends a top-up the node refuses outright on Retry (${code}): the next one is new, with a new key, after a fresh dry run`, async () => {
      const node = topUpNode();
      node.first.push(() => json({ error: 'upstream timed out' }, 504), answer);
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'it does not show the top-up');
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, words);
      expect(byTestId(c, 'mkt-topup')?.getAttribute('data-phase')).toBe('compose');
      expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe(code);
      expect(sessionStorage.length).toBe(0);
      await flush(300);
      await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
      const keys = topUps(node.requests).map(keyOf);
      expect(keys).toHaveLength(3);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
      expect(keys[2]).toMatch(UUID_V4);
    });
  }

  it('says a top-up went through when the node settles a lost answer by the budget, naming no transaction', async () => {
    const node = topUpNode();
    node.first.push('lose');
    node.untracked = true;
    const c = await topUpLlama();
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'it does not show the top-up');
    await node.land();
    await click(byTestId(c, 'mkt-topup-retry'));
    await waitForText(c, 'llama-3.1-8b-instruct topped up · the budget shows it');
    expect(byTestId(c, 'mkt-topup-sent')?.textContent).not.toContain('tx');
    expect(node.landings).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps a top-up of unknown outcome in the page when the browser refuses session storage', async () => {
    const refuse = () => { throw new DOMException('denied', 'SecurityError'); };
    const spies = (['getItem', 'setItem', 'removeItem'] as const).map((m) => vi.spyOn(Storage.prototype, m).mockImplementation(refuse));
    try {
      const node = topUpNode();
      node.first.push('lose');
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'it does not show the top-up');
      await click(buttonWithText(c, 'Cancel'));
      await click(byTestId(c, `mkt-topup-${FIXTURE_IDS.llama8b}`));
      await waitForText(c, 'it does not show the top-up');
      expect(byTestId(c, 'mkt-topup-confirm')).toBeNull();
      node.land();
      await click(byTestId(c, 'mkt-topup-retry'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up · tx');
      expect(node.landings).toBe(1);
      // Answered, it is gone from the page: a form for the same budget opens on a new top-up.
      const world = fixtureWorld();
      const fresh = await render(React.createElement(TopUp, {
        catalog: world.catalog(true), subscription: world.current, serviceId: FIXTURE_IDS.llama8b, onDone: () => undefined, onCancel: () => undefined,
      }));
      expect(byTestId(fresh, 'mkt-topup')?.getAttribute('data-phase')).toBe('compose');
      expect(byTestId(fresh, 'mkt-topup-confirm')).toBeTruthy();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  // A first send has nothing under its key before it: a refusal, even one given before the key is looked at, adds nothing.
  for (const [code, answer] of [['LimitExceeded', () => refusal(409, 'LimitExceeded', ['maxCostPerEpoch', '1', '2'])], ['InvalidRequest', () => refusal(400, 'InvalidRequest')]] as const) {
    it(`asks for a fresh dry run after a refusal of the first send (${code}), without looking the top-up up`, async () => {
      const node = topUpNode();
      node.first.push(answer);
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, code);
      expect(byTestId(c, 'mkt-error-card')?.getAttribute('data-code')).toBe(code);
      expect(byTestId(c, 'mkt-topup-unsure')).toBeNull();
      expect(sessionStorage.length).toBe(0);
      const sentAt = node.requests.indexOf(topUps(node.requests)[0]);
      expect(node.requests.slice(sentAt + 1).some((r) => r.method === 'GET' && r.url.startsWith('/api/marketplace/subscriptions'))).toBe(false);
      await flush(300);
      await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
      expect((byTestId(c, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(false);
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

  it('tops up a query budget the catalog lacks as a query budget, in its dry run and in the top-up sent', async () => {
    const query = `0x${'51'.repeat(32)}`;
    const world = fixtureWorld();
    const subscription = { ...world.current, budgets: [...world.current.budgets, { ...world.current.budgets[2], budgetIndex: 3, serviceId: query, serviceClass: 'query' as const }] };
    const writes = editedNode('active', (method, url, body) => {
      if (method !== 'GET' || !url.startsWith('/api/marketplace/subscriptions')) return;
      for (const s of body.subscriptions as Json[]) if (s.subscriptionId === subscription.subscriptionId) s.budgets = subscription.budgets;
    });
    const catalog = world.catalog(true);
    expect(catalog.services.some((s) => s.serviceId === query)).toBe(false);
    const c = await render(React.createElement(TopUp, { catalog, subscription, serviceId: query, onDone: () => undefined, onCancel: () => undefined }));
    await type(byTestId(c, 'mkt-topup-amount'), '0.5');
    await flush(300);
    await waitForText(c, 'Costs 0.5 TRAC from the buyer wallet for epoch 664');
    await click(byTestId(c, 'mkt-topup-confirm'));
    await waitForText(c, 'topped up');
    const classesSent = (suffix: string) => writes.filter((w) => w.url.endsWith(suffix)).map((w) => (w.body as { services: Array<{ serviceClass: string }> }).services[0].serviceClass);
    expect(classesSent('/top-up/preview').length).toBeGreaterThan(0);
    expect(new Set(classesSent('/top-up/preview'))).toEqual(new Set(['query']));
    expect(classesSent('/top-up')).toEqual(['query']);
  });

  const classCases: Array<[string, (b: Json) => void, string]> = [
    // The budget's class wins over the catalog's: the contract requires a top-up to repeat what it stores.
    ['the budget names its class', (b) => { b.serviceClass = 'query'; }, 'inference'],
    // A node that names no class on its budgets leaves the catalog to say.
    ['the node names no class for the budget', (b) => { delete b.serviceClass; }, 'query'],
  ];
  for (const [what, budgetEdit, catalogClass] of classCases) {
    it(`tops up a budget with the class it needs when ${what}`, async () => {
      const writes = editedNode('active', (method, url, body) => {
        if (method !== 'GET') return;
        if (url.startsWith('/api/marketplace/subscriptions')) {
          for (const s of (body.subscriptions as Json[]) ?? []) for (const b of s.budgets as Json[]) if (b.serviceId === FIXTURE_IDS.llama8b) budgetEdit(b);
        }
        if (url === '/api/marketplace/catalog') for (const s of body.services as Json[]) if (s.serviceId === FIXTURE_IDS.llama8b) s.serviceClass = catalogClass;
      });
      const c = await topUpLlama();
      await click(byTestId(c, 'mkt-topup-confirm'));
      await waitForText(c, 'llama-3.1-8b-instruct topped up');
      const classesSent = (suffix: string) => writes.filter((w) => w.url.endsWith(suffix)).map((w) => (w.body as { services: Array<{ serviceClass: string }> }).services[0].serviceClass);
      expect(classesSent('/top-up/preview').length).toBeGreaterThan(0);
      expect(new Set(classesSent('/top-up/preview'))).toEqual(new Set(['query']));
      expect(classesSent('/top-up')).toEqual(['query']);
    });
  }

  it('asks nothing for a service whose class neither the subscription nor the catalog names, and says why', async () => {
    const writes = recordWrites('active');
    const world = fixtureWorld();
    const c = await render(React.createElement(TopUp, {
      catalog: world.catalog(true), subscription: world.current, serviceId: `0x${'52'.repeat(32)}`, onDone: () => undefined, onCancel: () => undefined,
    }));
    await type(byTestId(c, 'mkt-topup-cap'), '1');
    await type(byTestId(c, 'mkt-topup-amount'), '0.5');
    await flush(300);
    expect(byTestId(c, 'mkt-topup-class')?.textContent).toContain('names this service\'s class, so no top-up can be asked for');
    expect((byTestId(c, 'mkt-topup-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(writes.filter((w) => w.url.includes('/top-up'))).toEqual([]);
  });
});
