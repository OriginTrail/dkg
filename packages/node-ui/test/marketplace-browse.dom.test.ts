// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketplaceView } from '../src/ui/marketplace/views/MarketplaceView.js';
import { FIXTURE_IDS } from '../src/ui/marketplace/api/fixtures.js';
import { MISSING_COPY, byTestId, click, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';

const browse = () => React.createElement(MarketplaceView);
const playgroundTab = (c: HTMLElement) => Array.from(c.querySelectorAll('[role="tab"]')).find((t) => t.textContent === 'Playground');

describe('marketplace Browse: catalog, service page, storefront, playground', () => {
  afterEach(unmountAll);

  it('lists a card per service with this epoch\'s prices and what the subscription has left', async () => {
    useFixtureNode('active');
    const c = await render(browse());
    await waitForText(c, 'qwen2.5-14b-instruct');
    expect(c.querySelectorAll('[data-testid^="mkt-card-"]').length).toBe(4);
    expect(byTestId(c, `mkt-card-${FIXTURE_IDS.qwen14b}`)?.textContent).toContain('0.6–0.7 µTRAC/tok');
    expect(byTestId(c, `mkt-card-${FIXTURE_IDS.qwen14b}`)?.textContent).toContain('2.16 TRAC left this epoch');
    expect(byTestId(c, `mkt-card-${FIXTURE_IDS.qwen14b}`)?.textContent).toContain('~$0.17–0.20/1M · reference rate');
    expect(byTestId(c, `mkt-add-${FIXTURE_IDS.mistral24b}`)?.textContent).toBe('Add to plan');
    expect(byTestId(c, 'mkt-seller-strip')?.textContent).toContain('seller 12');
    expect(byTestId(c, 'mkt-seller-strip')?.textContent).toContain('Epoch 664');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('opens a service\'s page with a row per seller, then a seller\'s storefront', async () => {
    useFixtureNode('active');
    const c = await render(browse());
    await waitForText(c, 'qwen2.5-7b-instruct');
    await click(byTestId(c, `mkt-card-${FIXTURE_IDS.qwen7b}`));
    await waitForText(c, 'next epoch 0.32 µTRAC');
    expect(c.querySelectorAll('[data-testid^="mkt-provider-"]').length).toBe(2);
    expect(byTestId(c, 'mkt-provider-12')?.textContent).toContain('205 ms from this node');
    expect(byTestId(c, 'mkt-provider-31')?.textContent).toContain('latency: no data yet');
    expect(c.textContent).toContain('your subscription covers this');
    // The mark is an icon, not a character.
    expect(c.querySelector('[data-copy="model.covered"] svg.lucide-check')).toBeTruthy();
    expect(c.textContent).not.toMatch(/[✓✗]/);
    await click(byTestId(c, 'mkt-open-seller-31'));
    await waitForText(c, 'Served value by epoch');
    expect(byTestId(c, 'mkt-storefront')?.textContent).toContain('stake factor 1.25');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('names the next epoch\'s price only where it changes', async () => {
    useFixtureNode('active');
    const c = await render(browse());
    await waitForText(c, 'qwen2.5-7b-instruct');
    await click(byTestId(c, `mkt-card-${FIXTURE_IDS.qwen7b}`));
    // Seller 12 moves from 0.3 to 0.32 µTRAC; seller 31 names the same price for the next epoch as for this one.
    await waitForText(c, 'next epoch 0.32 µTRAC');
    expect(byTestId(c, 'mkt-provider-12')?.textContent).toContain('next epoch 0.32 µTRAC');
    expect(byTestId(c, 'mkt-provider-31')?.textContent).not.toContain('next epoch');
    // So on a storefront: seller 31's qwen2.5-14b moves from 0.7 to 0.65, its other two offers stay.
    await click(byTestId(c, 'mkt-open-seller-31'));
    await waitForText(c, 'Served value by epoch');
    expect(byTestId(c, `mkt-store-offer-${FIXTURE_IDS.qwen14b}`)?.textContent).toContain('next epoch 0.65 µTRAC');
    expect(byTestId(c, `mkt-store-offer-${FIXTURE_IDS.qwen7b}`)?.textContent).not.toContain('next epoch');
    expect(byTestId(c, `mkt-store-offer-${FIXTURE_IDS.llama8b}`)?.textContent).not.toContain('next epoch');
  });

  it('chats through the gateway with a key of its own and shows what each answer cost', async () => {
    useFixtureNode('active');
    const c = await render(browse());
    await waitForText(c, 'Playground');
    await click(playgroundTab(c));
    await waitForText(c, 'qwen2.5-14b-instruct · 72% left');
    await type(byTestId(c, 'mkt-play-input') as HTMLInputElement, 'What is a knowledge graph?');
    await click(byTestId(c, 'mkt-play-send'));
    await waitForText(c, 'A knowledge graph links facts');
    expect(byTestId(c, 'mkt-served')?.textContent).toBe('via seller 12 · 412 tokens · 0.0002 TRAC · 2.1597 TRAC left in this budget');
    expect(byTestId(c, 'mkt-play-key')?.textContent).toContain('dkgmk_01234567');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('turns the soft ceiling into the fork: top up, or wait for the next epoch', async () => {
    useFixtureNode('active');
    const c = await render(browse());
    await waitForText(c, 'Playground');
    await click(playgroundTab(c));
    await waitForText(c, 'llama-3.1-8b-instruct');
    await click(byTestId(c, `mkt-chip-${FIXTURE_IDS.llama8b}`));
    await type(byTestId(c, 'mkt-play-input') as HTMLInputElement, 'hello');
    await click(byTestId(c, 'mkt-play-send'));
    await waitForText(c, 'This budget is at its soft ceiling — nothing was charged');
    expect(byTestId(c, 'mkt-fork-topup')).toBeTruthy();
    expect(byTestId(c, 'mkt-fork-ceiling')?.textContent).toContain('or wait for the next epoch, in 15 h');
  });

  it('asks to fund a subscription when none covers this epoch, and says when the marketplace is off', async () => {
    useFixtureNode('none');
    const c = await render(browse());
    await waitForText(c, 'Playground');
    await click(playgroundTab(c));
    await waitForText(c, 'No subscription funds the playground this epoch');
    expect(byTestId(c, 'mkt-playground')?.getAttribute('data-state')).toBe('no-plan');
    await unmountAll();
    useFixtureNode('off');
    const off = await render(browse());
    await waitForText(off, 'The marketplace is off on this node');
    expect(byTestId(off, 'mkt-marketplace')?.getAttribute('data-state')).toBe('off');
  });

  it('shows the admin-needed state when the playground may not make its key', async () => {
    useFixtureNode('viewer');
    const c = await render(browse());
    await waitForText(c, 'Playground');
    await click(playgroundTab(c));
    await waitForText(c, 'qwen2.5-14b-instruct');
    await type(byTestId(c, 'mkt-play-input') as HTMLInputElement, 'hello');
    await click(byTestId(c, 'mkt-play-send'));
    await waitForText(c, 'This needs the node-admin token');
  });
});
