// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperateView } from '../src/ui/marketplace/views/OperateView.js';
import { MISSING_COPY, byTestId, render, unmountAll, waitForText } from './helpers/marketplace-render.js';

describe('marketplace Operate', () => {
  afterEach(unmountAll);

  it('shows the ask editor, subscribers and the two separate wallets', async () => {
    const c = await render(React.createElement(OperateView));
    await waitForText(c, 'Your ask — takes effect next cycle');
    expect(byTestId(c, 'mkt-ask-cycle')?.textContent).toBe('Cycle 3 · a new ask takes effect from cycle 4');
    expect(byTestId(c, 'mkt-ask-qwen25-7b')?.textContent).toContain('queued for cycle 4: 0.32 µTRAC');
    expect(c.textContent).toContain('2 active subscriptions this period');
    expect(c.textContent).toContain('Statements awaiting your signature: 1');
    expect(byTestId(c, 'mkt-revenue-wallet')?.textContent).toContain('0xaaaaaaaa');
    expect(byTestId(c, 'mkt-ops-wallet')?.textContent).toContain('0x0d0d0d0d');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });
});
