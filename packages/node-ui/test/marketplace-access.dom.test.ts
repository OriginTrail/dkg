// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessView } from '../src/ui/marketplace/views/AccessView.js';
import { MISSING_COPY, byTestId, click, render, unmountAll, useFixtureState, waitForText } from './helpers/marketplace-render.js';

describe('marketplace Access', () => {
  afterEach(unmountAll);

  it('lists keys with their cap, mix and scopes; revoked and operator keys are marked', async () => {
    useFixtureState('plan-active');
    const c = await render(React.createElement(AccessView));
    await waitForText(c, 'my-agent');
    expect(byTestId(c, 'mkt-key-my-agent')?.textContent).toContain('61% of cap');
    expect(byTestId(c, 'mkt-key-ci-bot')?.textContent).toContain('2 models · no queries · 2 rps');
    expect(byTestId(c, 'mkt-key-old-demo')?.getAttribute('data-revoked')).toBe('true');
    expect(byTestId(c, 'mkt-key-k_op')?.textContent).toContain('cannot be revoked');
    await click(byTestId(c, 'mkt-mint-open'));
    expect(byTestId(c, 'mkt-mint-form')?.textContent).toContain('Mint a key');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });
});
