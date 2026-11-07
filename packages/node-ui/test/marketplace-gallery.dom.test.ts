// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketplaceGalleryView } from '../src/ui/marketplace/GalleryView.js';
import { MISSING_COPY, render, unmountAll } from './helpers/marketplace-render.js';

describe('marketplace component gallery', () => {
  afterEach(unmountAll);

  it('renders every component state on fixture data, labeled as fixtures', async () => {
    const c = await render(React.createElement(MarketplaceGalleryView));
    expect(c.textContent).toContain('Component gallery · fixture data · not live');
    expect(c.textContent).toContain('Marketplace component gallery');
    for (const text of ['Verified ✓', 'Waiting for delivery', 'Payment blocked', 'Weights verified', 'Qwen2.5 14B Instruct', 'E_OVERBILL']) {
      expect(c.textContent).toContain(text);
    }
    expect(c.querySelectorAll('.mktx .gauge-radial').length).toBe(4);
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('shows the minted key once, then only its prefix', async () => {
    const c = await render(React.createElement(MarketplaceGalleryView));
    expect(c.textContent).toContain('mk_9f3ab6e01d5c47f2b8a9');
    const done = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Done');
    done!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.textContent).not.toContain('mk_9f3ab6e01d5c47f2b8a9');
  });
});
