// @vitest-environment happy-dom
//
// "What is a PCA?" primer (R1): the button owns the dialog's open state, the dialog
// explains PCAs on its own (the docs page covers only the CLI and API), and it closes
// on Escape and the Close button.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { PcaPrimerLink, PCA_DOCS_URL } = await import('../src/ui/pages/conviction/PcaPrimer.js');

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const trigger = () => document.querySelector('[data-testid="pca-primer-link"]') as HTMLButtonElement;
const dialog = () => document.querySelector('[data-testid="pca-primer"]');

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PcaPrimerLink', () => {
  it('is a small secondary button, not bare text, and starts closed', async () => {
    const { unmount } = await render(React.createElement(PcaPrimerLink));
    expect(trigger().className).toBe('ds-btn ds-sm');
    expect(trigger().textContent).toBe('What is a PCA?');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(dialog()).toBeNull();
    await unmount();
  });

  it('size="md" drops ds-sm so it matches a default button beside it', async () => {
    const { unmount } = await render(React.createElement(PcaPrimerLink, { size: 'md' }));
    expect(trigger().className).toBe('ds-btn');
    await unmount();
  });

  it('opens a named dialog that explains every part of a PCA', async () => {
    const { unmount } = await render(React.createElement(PcaPrimerLink));
    await act(async () => { trigger().click(); });
    const d = dialog()!;
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.querySelector('#pca-modal-title')?.textContent).toBe('What is a PCA?');
    const titles = [...d.querySelectorAll('.v10-pca-primer-title')].map((h) => h.textContent);
    expect(titles).toEqual(['What you commit', 'What you get', 'Who gets the discount', 'Two ways in', 'How it’s spent', 'When it ends']);
    const text = d.textContent ?? '';
    expect(text).toContain('At least 25,000 TRAC');
    expect(text).toContain('Committed TRAC isn’t returned');
    expect(text).toContain('TRAC publishing fee only, not on gas');
    expect(text).toContain('up to 100');
    expect(text).toContain('signed by one of a node’s publishing wallets');
    expect(text).toContain('Topping up doesn’t make the PCA last longer');
    expect(text).not.toMatch(/\block/i);
    // The allowance resets with the PCA's own billing periods, counted from creation, not at
    // the network's next epoch.
    expect(text).toContain('counts from when the PCA was created');
    expect(text).toContain('until the PCA’s next billing period starts');
    expect(text).not.toContain('next epoch');
    // The tier ladder shows every tier with none highlighted (no amount entered).
    const rows = d.querySelectorAll('.v10-pca-tier-row');
    expect(rows.length).toBe(7);
    expect(d.querySelector('.v10-pca-tier-row.active')).toBeNull();
    // The docs link is for the CLI and API, and leaves the app.
    const link = d.querySelector(`a[href="${PCA_DOCS_URL}"]`) as HTMLAnchorElement;
    expect(PCA_DOCS_URL).toBe('https://docs.origintrail.io/operate/publishing-conviction');
    expect(link.target).toBe('_blank');
    expect(link.querySelector('.ds-external-mark')).toBeTruthy();
    await unmount();
  });

  it('closes on the Close button and on Escape', async () => {
    const { unmount } = await render(React.createElement(PcaPrimerLink));
    await act(async () => { trigger().click(); });
    const close = [...dialog()!.querySelectorAll('.v10-modal-footer button')].find((b) => b.textContent === 'Close') as HTMLButtonElement;
    await act(async () => { close.click(); });
    expect(dialog()).toBeNull();

    await act(async () => { trigger().click(); });
    expect(dialog()).toBeTruthy();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dialog()).toBeNull();
    await unmount();
  });
});
