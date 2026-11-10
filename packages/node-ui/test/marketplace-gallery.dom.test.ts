// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceGalleryView } from '../src/ui/marketplace/GalleryView.js';
import { MISSING_COPY, byTestId, click, render, unmountAll } from './helpers/marketplace-render.js';

describe('marketplace component gallery', () => {
  afterEach(unmountAll);

  it('renders the building blocks on fixture answers, labeled as fixtures, with no request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const c = await render(React.createElement(MarketplaceGalleryView));
    expect(c.textContent).toContain('Component gallery · fixture data · not live');
    for (const text of ['held', 'landed', 'missed', 'Weights verified', 'Seller-reported model', '2.16 TRAC left this epoch',
      'Epoch 664: 27% of its value landed, 3% held', 'One confirmation — this epoch\'s funding', 'Try again in 120 s',
      'The seller\'s receipt failed this node\'s check', 'Selling is off on this node', 'The marketplace isn\'t available on this node']) {
      expect(c.textContent).toContain(text);
    }
    expect(c.querySelectorAll('.mkt-bar').length).toBe(3);
    // Each refusal reads as the client reads the node's answer.
    expect(Array.from(c.querySelectorAll('[data-testid="mkt-error-card"]'), (e) => e.getAttribute('data-code')))
      .toEqual(['MarketplaceOff', 'NodeAdminRequired', 'InsufficientAllowance', 'epoch_ending', 'soft_ceiling', 'bad_receipt']);
    expect(c.textContent).not.toContain(MISSING_COPY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the new key\'s secret once, then only its prefix', async () => {
    const c = await render(React.createElement(MarketplaceGalleryView));
    expect(byTestId(c, 'mkt-key-plaintext')?.textContent).toContain('dkgmk_0123456789abcdef');
    await click(byTestId(c, 'mkt-key-done'));
    expect(byTestId(c, 'mkt-key-plaintext')).toBeNull();
    expect(byTestId(c, 'mkt-gallery-key-gone')?.textContent).toBe('Secret dismissed — only the prefix dkgmk_01234567 remains');
  });
});
