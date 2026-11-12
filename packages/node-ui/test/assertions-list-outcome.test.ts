// @vitest-environment happy-dom
// The assertion list shows each promote/publish outcome with one tone: success,
// warning (went through with something to flag) or danger.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listAssertions: vi.fn(),
  promoteAssertion: vi.fn(),
  knowledgeAssetPublish: vi.fn(),
  publishAssertionsToVm: vi.fn(),
  invalidateQueryCache: vi.fn(),
}));
const pageMocks = vi.hoisted(() => ({
  listAssertionsPage: vi.fn(),
  fetchAssertionPageCounts: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/api.js')>()),
  ...apiMocks,
}));
vi.mock('../src/ui/assertions-page.js', () => pageMocks);
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useMemoryGraphEvents: () => undefined }));

const { AssertionsList } = await import('../src/ui/views/project/components/assertions.js');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const A = { name: 'alpha', graphUri: 'g-alpha' };
const B = { name: 'beta', graphUri: 'g-beta' };
let root: Root | null = null;

async function renderList(layer: 'wm' | 'swm') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(React.createElement(AssertionsList, { contextGraphId: 'cg', layer, onComplete: () => undefined })); });
  for (let i = 0; i < 20 && !container.textContent?.includes('Page 1'); i++) await flush();
  return container;
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function clickText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
  expect(button, text).toBeTruthy();
  await act(async () => { button.click(); });
  for (let i = 0; i < 20; i++) await flush();
}
const outcome = (container: HTMLElement, testid: string) => container.querySelector(`[data-testid="${testid}"]`);

beforeEach(() => {
  pageMocks.listAssertionsPage.mockResolvedValue({ items: [A, B], nextCursor: undefined });
  pageMocks.fetchAssertionPageCounts.mockResolvedValue({});
  apiMocks.listAssertions.mockResolvedValue([A, B]);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('AssertionsList outcome tone', () => {
  it('a clean publish of all is a success', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({ published: 2, total: 2, partial: 0, failures: [] });
    const c = await renderList('swm');
    await clickText(c, 'Publish all to Verifiable Memory');
    expect(outcome(c, 'assertion-publish-result')?.textContent).toContain('Published 2 knowledge assets to Verifiable Memory');
    expect(outcome(c, 'assertion-publish-result')?.getAttribute('data-tone')).toBe('success');
  });

  it('a partial publish of all is a warning', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({ published: 1, total: 2, partial: 1, partialError: 'registry write pending', failures: [] });
    const c = await renderList('swm');
    await clickText(c, 'Publish all to Verifiable Memory');
    expect(outcome(c, 'assertion-publish-result')?.getAttribute('data-tone')).toBe('warning');
  });

  it('an all-unknown publish is a warning, not an error', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({
      published: 0, total: 2, partial: 0, failures: [],
      outcomeUnknown: [{ name: 'alpha', error: 'no response' }, { name: 'beta', error: 'no response' }],
    });
    const c = await renderList('swm');
    await clickText(c, 'Publish all to Verifiable Memory');
    expect(outcome(c, 'assertion-publish-result')?.textContent).toContain('publish outcome unknown');
    expect(outcome(c, 'assertion-publish-result')?.getAttribute('data-tone')).toBe('warning');
  });

  it('a failed publish of all is danger', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({ published: 0, total: 2, partial: 0, failures: [{ name: 'alpha', error: 'tx reverted' }] });
    const c = await renderList('swm');
    await clickText(c, 'Publish all to Verifiable Memory');
    expect(outcome(c, 'assertion-publish-result')?.textContent).toContain('alpha: tx reverted');
    expect(outcome(c, 'assertion-publish-result')?.getAttribute('data-tone')).toBe('danger');
  });

  it('one row published with a Context Graph binding error is a warning', async () => {
    apiMocks.knowledgeAssetPublish.mockResolvedValue({ contextGraphError: 'registry write pending' });
    const c = await renderList('swm');
    await clickText(c, 'Publish to Verifiable Memory');
    expect(outcome(c, 'assertion-publish-result')?.getAttribute('data-tone')).toBe('warning');
  });

  it('sharing all to Shared Memory is a success', async () => {
    apiMocks.promoteAssertion.mockResolvedValue({ promotedCount: 3 });
    const c = await renderList('wm');
    await clickText(c, 'Share all complete Knowledge Assets');
    expect(outcome(c, 'assertion-promote-result')?.textContent).toContain('Shared 2 complete Knowledge Assets');
    expect(outcome(c, 'assertion-promote-result')?.getAttribute('data-tone')).toBe('success');
  });
});
