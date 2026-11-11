// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Preview } from '../src/ui/marketplace/api/types.js';
import { usePreview, type PreviewState, type Retain } from '../src/ui/marketplace/purchase/usePreview.js';
import { flush } from './helpers/marketplace-render.js';

type Req = { value: number };

const previewOf = (value: number): Preview => ({
  epoch: 664, source: { kind: 'wallet' }, value: String(value), valueTrac: `${value}.0`, cost: String(value), costTrac: `${value}.0`, discountBps: 0,
});

/** An `ask` whose answers wait until the test settles them, one by one. */
function node() {
  const asked: Array<{ request: Req; resolve: (p: Preview) => void; reject: (e: unknown) => void }> = [];
  const ask = (request: Req) => new Promise<Preview>((resolve, reject) => { asked.push({ request, resolve, reject }); });
  return { asked, ask };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let state: PreviewState<Req> | null = null;
/** Every state the hook rendered with, in order. */
const renders: Array<PreviewState<Req>> = [];

function Probe({ request, ask, retain, round }: { request: Req | null; ask: (r: Req) => Promise<Preview>; retain: Retain; round?: number }): null {
  state = usePreview(request, ask, { retain, round });
  renders.push(state);
  return null;
}

async function show(props: React.ComponentProps<typeof Probe>): Promise<void> {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root!.render(React.createElement(Probe, props)); });
}

/** Past the settle delay, so the hook has asked. */
const settle = () => flush(300);

describe('the dry-run hook', () => {
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    container?.remove();
    root = null; container = null; state = null;
    renders.length = 0;
  });

  it('ties each answer to its request: the last stays on show while the next loads, but only the request\'s own is current', async () => {
    const n = node();
    await show({ request: { value: 1 }, ask: n.ask, retain: 'last' });
    expect(state!.busy).toBe(true);
    await settle();
    await act(async () => { n.asked[0].resolve(previewOf(1)); });
    expect(state!.current?.preview.value).toBe('1');
    expect(state!.current?.request).toEqual({ value: 1 });

    const before = renders.length;
    await show({ request: { value: 50 }, ask: n.ask, retain: 'last' });
    // The render that changes the request, before the hook has even marked itself busy, has no current answer.
    expect(renders[before]).toMatchObject({ busy: false, current: null, shown: { request: { value: 1 } } });
    await settle();
    expect(n.asked.map((a) => a.request)).toEqual([{ value: 1 }, { value: 50 }]);
    expect(state!.busy).toBe(true);
    expect(state!.current).toBeNull();
    expect(state!.shown?.preview.value).toBe('1');
    await act(async () => { n.asked[1].resolve(previewOf(50)); });
    expect(state!.busy).toBe(false);
    expect(state!.current).toEqual({ request: { value: 50 }, preview: previewOf(50) });
  });

  it('clears the answer at once when the request changes under retain none, and asks again for a new round', async () => {
    const n = node();
    await show({ request: { value: 1 }, ask: n.ask, retain: 'none', round: 0 });
    await settle();
    await act(async () => { n.asked[0].resolve(previewOf(1)); });
    expect(state!.current?.preview.value).toBe('1');

    await show({ request: { value: 1 }, ask: n.ask, retain: 'none', round: 1 });
    expect(state!.current).toBeNull();
    expect(state!.shown).toBeNull();
    await settle();
    expect(n.asked.map((a) => a.request)).toEqual([{ value: 1 }, { value: 1 }]);
    await act(async () => { n.asked[1].resolve(previewOf(1)); });
    expect(state!.current?.preview.value).toBe('1');
  });

  it('drops a late answer to a request no longer asked about', async () => {
    const n = node();
    await show({ request: { value: 1 }, ask: n.ask, retain: 'last' });
    await settle();
    await show({ request: { value: 2 }, ask: n.ask, retain: 'last' });
    await settle();
    await act(async () => { n.asked[1].resolve(previewOf(2)); });
    await act(async () => { n.asked[0].resolve(previewOf(1)); });
    expect(state!.current).toEqual({ request: { value: 2 }, preview: previewOf(2) });
  });

  it('clears the answer and the error for invalid input, and is not left busy', async () => {
    const n = node();
    await show({ request: { value: 1 }, ask: n.ask, retain: 'last' });
    await settle();
    await act(async () => { n.asked[0].reject(new Error('refused')); });
    expect(state!.err).toBeInstanceOf(Error);
    expect(state!.shown).toBeNull();

    await show({ request: { value: 2 }, ask: n.ask, retain: 'last' });
    // Invalid input while the dry run is still settling: nothing is asked, and nothing is loading.
    await show({ request: null, ask: n.ask, retain: 'last' });
    await settle();
    expect(n.asked).toHaveLength(1);
    expect(state).toMatchObject({ shown: null, current: null, err: null, busy: false });
  });

  it('keeps the error of the last answer under retain last until the next one comes', async () => {
    const n = node();
    await show({ request: { value: 1 }, ask: n.ask, retain: 'last' });
    await settle();
    await act(async () => { n.asked[0].reject(new Error('refused')); });
    await show({ request: { value: 3 }, ask: n.ask, retain: 'last' });
    await settle();
    expect(state!.err).toBeInstanceOf(Error);
    await act(async () => { n.asked[1].resolve(previewOf(3)); });
    expect(state!.err).toBeNull();
    expect(state!.current?.preview.value).toBe('3');
  });
});
