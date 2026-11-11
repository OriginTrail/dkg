// Render helpers for the marketplace section's DOM tests: mount a view on the
// fixture node (a stubbed fetch answering /api/marketplace), pick its state,
// and wait for text.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { fixtureFetch, type FixtureScenario } from '../../src/ui/marketplace/api/fixtures.js';
import { forgetFundings } from '../../src/ui/marketplace/purchase/fundings.js';
import { forgetPlanSaves } from '../../src/ui/marketplace/purchase/planSaves.js';
import { forgetTopUpAttempts } from '../../src/ui/marketplace/purchase/topUpAttempts.js';
import { forgetPlaygroundKey } from '../../src/ui/marketplace/views/Playground.js';

/** What `copy()` prints for a key the string table lacks. */
export const MISSING_COPY = '⟦missing copy';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** Answer the section's API calls from the fixture node in `scenario`. */
export function useFixtureNode(scenario: FixtureScenario): void {
  vi.stubGlobal('fetch', fixtureFetch(scenario));
}

export async function flush(ms = 0): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

export async function render(node: React.ReactElement): Promise<HTMLElement> {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => { root.render(node); });
  await flush();
  await flush();
  return container;
}

export async function unmountAll(): Promise<void> {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    await act(async () => { root.unmount(); });
    container.remove();
  }
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  forgetPlaygroundKey();
  forgetPlanSaves();
  forgetFundings();
  forgetTopUpAttempts();
}

/** One view goes, as a tab change takes it away: the page, its stores and the node stay. */
export async function unmount(container: HTMLElement): Promise<void> {
  const i = mounted.findIndex((m) => m.container === container);
  if (i < 0) throw new Error('unmount: not a view rendered here');
  const [{ root }] = mounted.splice(i, 1);
  await act(async () => { root.unmount(); });
  container.remove();
}

/** The tab reloads: every view goes, the node stays as it is, and so does the tab's session storage. */
export async function reloadPage(): Promise<void> {
  const kept = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)!).map((k) => [k, sessionStorage.getItem(k)!] as const);
  const node = globalThis.fetch;
  await unmountAll();
  for (const [k, v] of kept) sessionStorage.setItem(k, v);
  vi.stubGlobal('fetch', node);
}

export async function waitForText(container: HTMLElement, text: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((container.textContent ?? '').includes(text)) return;
    await flush(10);
  }
  throw new Error(`Timed out waiting for "${text}" (have: ${(container.textContent ?? '').slice(0, 300)})`);
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('click: element not found');
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  await flush();
}

/** Type into a React-controlled input or select: React reads the change off its own value tracker. */
export async function type(el: Element | null | undefined, value: string): Promise<void> {
  if (!el) throw new Error('type: element not found');
  const field = el as HTMLInputElement & { _valueTracker?: { setValue(v: string): void } };
  await act(async () => {
    const before = field.value;
    field.value = value;
    field._valueTracker?.setValue(before === value ? `${value}-` : before);
    field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
}

export const byTestId = (container: ParentNode, id: string) => container.querySelector(`[data-testid="${id}"]`);

export function buttonWithText(container: ParentNode, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text) ?? null;
}
