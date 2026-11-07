// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PlansView } from '../src/ui/marketplace/views/PlansView.js';
import { MISSING_COPY, buttonWithText, byTestId, click, render, unmountAll, useFixtureState, waitForText } from './helpers/marketplace-render.js';

const plans = () => React.createElement(PlansView);

describe('marketplace Plans and the purchase flow', () => {
  afterEach(unmountAll);

  it('shows the active plan: summary, one meter per line, add-ons, statement and activity', async () => {
    useFixtureState('plan-active');
    const c = await render(plans());
    await waitForText(c, "Plan overall: 34% of this period's value used");
    expect(byTestId(c, 'mkt-plans')?.getAttribute('data-state')).toBe('active');
    expect(byTestId(c, 'mkt-meter-gpt-5x')?.getAttribute('data-state')).toBe('exhausted');
    expect(byTestId(c, 'mkt-meter-gpt-5x')?.textContent).toContain("You've reached this ceiling");
    expect(byTestId(c, 'mkt-meter-okf-knowledge')?.textContent).toContain('At this pace');
    expect(byTestId(c, 'mkt-addon-row-gpt-6-astra')).toBeTruthy();
    expect(c.textContent).toContain('This period: our count 1,238,400 · provider count 1,238,400 ✓');
    expect(c.textContent).toContain('Recent activity');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('starts a never-subscribed node on the starter plan, then the composer', async () => {
    useFixtureState('plan-none');
    const c = await render(plans());
    await waitForText(c, 'Three steps to your first answer');
    expect(byTestId(c, 'mkt-starter')?.textContent).toContain('qwen25-14b + qwen25-7b + gpt-5x + okf-knowledge + gpt-6-astra');
    await click(byTestId(c, 'mkt-starter-choose'));
    expect(byTestId(c, 'mkt-composer')).toBeTruthy();
    expect(c.textContent).toContain('Compose your plan');
    expect(byTestId(c, 'mkt-wallet-connect')).toBeTruthy();
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('resumes a purchase at the one-confirmation gate with every frozen number', async () => {
    useFixtureState('purchase-confirm');
    const c = await render(plans());
    await waitForText(c, 'One confirmation — your plan\'s payments');
    const gate = byTestId(c, 'mkt-confirm-gate');
    expect(gate?.textContent).toContain('2.8 TRAC to 0x1111…1111');
    expect(gate?.textContent).toContain('0.8 TRAC to 0x2222…2222');
    expect(gate?.textContent).toContain('2 transfers · 3.6 TRAC total (~$1.01)');
    expect(byTestId(c, 'mkt-resume-banner')).toBeTruthy();
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('resumes a purchase at the pay step, one row per provider', async () => {
    useFixtureState('purchase-pay');
    const c = await render(plans());
    await waitForText(c, 'Pay each provider');
    expect(c.querySelectorAll('[data-testid^="mkt-pay-row-"]').length).toBe(2);
    expect(c.textContent).toContain('Paid ✓');
    expect(c.textContent).toContain('A payment is already attached');
  });

  it('ends a finished purchase on the copy-your-key step', async () => {
    useFixtureState('purchase-key');
    const c = await render(plans());
    await waitForText(c, 'Plan active');
    expect(byTestId(c, 'mkt-active-step')?.textContent).toContain('Get your key');
    expect(buttonWithText(c, '+ Mint key')).toBeTruthy();
  });

  it('offers a new period once the last one has ended', async () => {
    useFixtureState('plan-ended');
    const c = await render(plans());
    await waitForText(c, 'Period ended');
    expect(byTestId(c, 'mkt-new-period')?.textContent).toBe('Start a new period');
  });
});
