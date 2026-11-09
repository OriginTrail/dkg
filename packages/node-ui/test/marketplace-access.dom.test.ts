// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessView } from '../src/ui/marketplace/views/AccessView.js';
import { MISSING_COPY, byTestId, click, render, type, unmountAll, useFixtureNode, waitForText } from './helpers/marketplace-render.js';

const access = () => React.createElement(AccessView);

describe('marketplace Access', () => {
  afterEach(unmountAll);

  it('lists the keys in TRAC: spent and left, services, rate, expiry, last use and the mix', async () => {
    useFixtureNode('active');
    const c = await render(access());
    await waitForText(c, 'my-agent');
    const agent = byTestId(c, 'mkt-key-dkgmk_1a2b3c4d');
    expect(agent?.textContent).toContain('0.61 of 2 TRAC spent · 1.39 TRAC left');
    expect(agent?.textContent).toContain('Every service this epoch\'s subscription funds · 5 rps · never · last used 5 min ago');
    expect(agent?.textContent).toContain('31% of budget');
    expect(agent?.textContent).toContain('mostly qwen2.5-14b-instruct');
    expect(byTestId(c, 'mkt-key-dkgmk_5e6f7a8b')?.textContent).toContain('2 services · 2 rps · expires in 23 d');
    expect(byTestId(c, 'mkt-key-dkgmk_9c0d1e2f')?.getAttribute('data-revoked')).toBe('true');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('mints a key and shows its secret once, with the gateway\'s base URL', async () => {
    useFixtureNode('active');
    const c = await render(access());
    await waitForText(c, 'my-agent');
    await click(byTestId(c, 'mkt-mint-open'));
    await type(byTestId(c, 'mkt-mint-budget'), '0.25');
    await click(byTestId(c, 'mkt-mint'));
    await waitForText(c, 'Your new key');
    expect(byTestId(c, 'mkt-key-plaintext')?.textContent).toContain('/api/marketplace/v1');
    await click(byTestId(c, 'mkt-key-done'));
    expect(byTestId(c, 'mkt-key-plaintext')).toBeNull();
  });

  it('needs the node-admin token', async () => {
    useFixtureNode('viewer');
    const c = await render(access());
    await waitForText(c, 'This needs the node-admin token');
    expect(byTestId(c, 'mkt-access')?.getAttribute('data-state')).toBe('admin');
  });
});
