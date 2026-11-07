// Render helpers for the marketplace section's DOM tests: mount a view on the
// fixture data module, pick the fixture state, and wait for text.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FIXTURE_SCENARIO_KEY } from '../../src/ui/marketplace/data.js';
import type { FixtureScenario } from '../../src/ui/marketplace/fixtures.js';

/** What `copy()` prints for a key the string table lacks. */
export const MISSING_COPY = '⟦missing copy';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

export function useFixtureState(scenario: FixtureScenario): void {
  localStorage.setItem(FIXTURE_SCENARIO_KEY, scenario);
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

export const byTestId = (container: ParentNode, id: string) => container.querySelector(`[data-testid="${id}"]`);

export function buttonWithText(container: ParentNode, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text) ?? null;
}
