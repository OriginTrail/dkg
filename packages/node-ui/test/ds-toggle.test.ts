// @vitest-environment happy-dom
//
// Toggle: one on/off control, named for assistive tech, that ignores clicks
// while a save is in progress.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Toggle } from '../src/ui/components/ds/Toggle.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Toggle', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  const render = async (props: React.ComponentProps<typeof Toggle>) => {
    await act(async () => { root.render(React.createElement(Toggle, props)); });
    return container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
  };

  it('reports its state and name, and calls back on click', async () => {
    const onClick = vi.fn();
    const sw = await render({ checked: false, onClick, 'aria-label': 'Share telemetry' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('aria-label')).toBe('Share telemetry');
    expect(sw.type).toBe('button');
    await act(async () => { sw.click(); });
    expect(onClick).toHaveBeenCalledOnce();
    expect((await render({ checked: true, onClick, 'aria-label': 'Share telemetry' })).getAttribute('aria-checked')).toBe('true');
  });

  it('forwards its ref and stays focusable while busy, so a dialog can return focus to it', async () => {
    const ref = React.createRef<HTMLButtonElement>();
    await act(async () => { root.render(React.createElement(Toggle, { ref, checked: false, busy: true, 'aria-label': 'Share telemetry' })); });
    expect(ref.current?.getAttribute('role')).toBe('switch');
    expect(ref.current?.hasAttribute('disabled')).toBe(false);
    ref.current!.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it('ignores clicks while busy, and says so', async () => {
    const onClick = vi.fn();
    const sw = await render({ checked: false, busy: true, onClick, 'aria-label': 'Share telemetry' });
    expect(sw.getAttribute('aria-busy')).toBe('true');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { sw.click(); });
    expect(onClick).not.toHaveBeenCalled();
  });
});
