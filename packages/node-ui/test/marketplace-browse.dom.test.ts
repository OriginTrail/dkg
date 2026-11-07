// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketplaceView } from '../src/ui/marketplace/views/MarketplaceView.js';
import { MISSING_COPY, byTestId, click, render, unmountAll, useFixtureState, waitForText } from './helpers/marketplace-render.js';

describe('marketplace Browse: catalog, model page, playground', () => {
  afterEach(unmountAll);

  it('lists one card per offering with live prices and the buyer\'s meters', async () => {
    useFixtureState('plan-active');
    const c = await render(React.createElement(MarketplaceView));
    await waitForText(c, 'Qwen2.5 14B Instruct');
    const cards = c.querySelectorAll('[data-testid^="mkt-card-"]');
    expect(cards.length).toBe(5);
    expect(byTestId(c, 'mkt-card-qwen25-14b')?.textContent).toContain('76% left');
    expect(byTestId(c, 'mkt-card-qwen25-7b')?.textContent).toContain('0.3 µTRAC/tok');
    expect(byTestId(c, 'mkt-card-gpt-6-astra')?.textContent).toContain('Add to this period');
    expect(byTestId(c, 'mkt-seller-strip')?.textContent).toContain('online');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('opens a model page with a row per provider', async () => {
    useFixtureState('plan-active');
    const c = await render(React.createElement(MarketplaceView));
    await waitForText(c, 'Qwen2.5 7B Instruct');
    await click(byTestId(c, 'mkt-card-qwen25-7b'));
    expect(byTestId(c, 'mkt-model-page')).toBeTruthy();
    expect(c.querySelectorAll('[data-testid^="mkt-provider-"]').length).toBe(2);
    expect(c.textContent).toContain('your provider ✓');
    expect(c.textContent).toContain('Switch next period');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('offers the plan\'s meters in the playground', async () => {
    useFixtureState('plan-active');
    const c = await render(React.createElement(MarketplaceView));
    await waitForText(c, 'Playground');
    const tab = Array.from(c.querySelectorAll('[role="tab"]')).find((t) => t.textContent === 'Playground');
    await click(tab);
    expect(byTestId(c, 'mkt-playground')?.getAttribute('data-mode')).toBe('chat');
    expect(byTestId(c, 'mkt-chip-qwen25-14b')?.textContent).toBe('qwen25-14b · 76% left');
    expect(c.textContent).toContain('Send a message to the chosen model');
  });

  it('asks for a new period when there is no plan', async () => {
    useFixtureState('plan-none');
    const c = await render(React.createElement(MarketplaceView));
    await waitForText(c, 'Playground');
    const tab = Array.from(c.querySelectorAll('[role="tab"]')).find((t) => t.textContent === 'Playground');
    await click(tab);
    expect(byTestId(c, 'mkt-playground')?.getAttribute('data-state')).toBe('no-plan');
    expect(c.textContent).toContain('No active plan — the playground needs one');
  });
});
