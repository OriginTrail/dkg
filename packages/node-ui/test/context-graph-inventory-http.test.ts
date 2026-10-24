// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Keep the API wrapper, cache and resource owners real. Only HTTP/SSE IO is fake.
class Events {
  static current: Events;
  handlers = new Map<string, (event: { data: string }) => void>();
  close = vi.fn();
  constructor() { Events.current = this; }
  addEventListener(type: string, callback: (event: { data: string }) => void) { this.handlers.set(type, callback); }
  emit(type: string) { this.handlers.get(type)?.({ data: '{}' }); }
}
const json = (value: unknown) => new Response(JSON.stringify(value));
const rows = (id: string) => ({ contextGraphs: [{ id, name: id, callerInvolved: true }] });
const agent = { agentDid: 'did:dkg:agent:0xabc', peerId: 'peer' };
let root: Root | null;
let container: HTMLDivElement;
let latest: ReturnType<typeof import('../src/ui/hooks/useMyContextGraphs.js').useMyContextGraphs>;
let list: () => Promise<Response>;
let identity: (signal: AbortSignal) => Promise<Response>;
let http: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.__DKG_TOKEN__ = 'inventory-session';
  vi.stubGlobal('EventSource', Events);
  list = async () => json(rows('healthy'));
  identity = async () => json(agent);
  http = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/status') return json({});
    if (url === '/api/context-graph/list') return list();
    if (url === '/api/agent/identity') return identity(init?.signal as AbortSignal);
    throw new Error(`Unexpected HTTP request: ${url}`);
  });
  vi.stubGlobal('fetch', http);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; container.remove(); delete window.__DKG_TOKEN__;
  vi.unstubAllGlobals(); vi.useRealTimers();
});
async function mount(consumers = 1) {
  const { useMyContextGraphs } = await import('../src/ui/hooks/useMyContextGraphs.js');
  function Probe() { latest = useMyContextGraphs(); return null; }
  await act(async () => { root!.render(React.createElement(React.Fragment, {},
    ...Array.from({ length: consumers }, (_, key) => React.createElement(Probe, { key })))); });
}
const listCalls = () => http.mock.calls.filter(([url]) => url === '/api/context-graph/list').length;

it.each(['headers', 'body'])('bounds stalled identity %s so mutation completion and inventory polling recover', async stage => {
  let signal: AbortSignal | undefined;
  let release!: (value: Response) => void;
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancelBody = vi.fn();
  identity = async supplied => {
    signal = supplied;
    if (stage === 'headers') return new Promise(resolve => { release = resolve; });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; }, cancel: cancelBody }));
  };
  await mount();
  const { refreshContextGraphInventoryAfterMutation } = await import('../src/ui/hooks/useContextGraphInventory.js');
  let outcome: unknown = 'pending';
  let mutation!: Promise<void>;
  await act(async () => {
    mutation = refreshContextGraphInventoryAfterMutation().then(value => { outcome = value; });
  });
  expect(listCalls()).toBe(2);
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(outcome).toEqual({ ok: true, contextGraphs: rows('healthy').contextGraphs });
    expect(latest.identityLoading).toBe(false);
    expect(latest.identityError).toContain('timed out');
    expect(signal?.aborted).toBe(true);
    if (stage === 'body') expect(cancelBody).toHaveBeenCalledTimes(1);
    identity = async () => json({ ...agent, agentDid: 'did:dkg:agent:0xnew' });
    // The normal poll reuses its five-minute cached list until that TTL ends.
    await act(async () => { await vi.advanceTimersByTimeAsync(290_000); });
    expect(listCalls()).toBe(3);
    expect(latest.identityError).toBeNull();
    expect(latest.identity?.agentDid).toBe('did:dkg:agent:0xnew');
    // A non-cooperative old fetch cannot overwrite the successful retry.
    if (stage === 'headers') await act(async () => { release(json(agent)); });
    expect(latest.identity?.agentDid).toBe('did:dkg:agent:0xnew');
  } finally {
    // Also release the baseline implementation after a deliberate red assertion.
    if (stage === 'headers') release(json(agent));
    else if (!cancelBody.mock.calls.length) { body!.enqueue(new TextEncoder().encode(JSON.stringify(agent))); body!.close(); }
    await act(async () => { await mutation; });
  }
});

it('Retry starts fresh HTTP through the real wrapper/cache and keeps the new snapshot after an old reply', async () => {
  const pending: Array<(value: Response) => void> = [];
  list = () => new Promise(resolve => { pending.push(resolve); });
  await mount();
  expect(listCalls()).toBe(1);
  let retry!: Promise<unknown>;
  await act(async () => { retry = latest.retry(); });
  try {
    expect(listCalls()).toBe(2);
    await act(async () => { pending[1](json(rows('new'))); await retry; });
    await act(async () => { pending[0](json(rows('old'))); });
    expect(latest.myCgs.map(cg => cg.id)).toEqual(['new']);
    const { api } = await import('../src/ui/api-wrapper.js');
    expect(await api.fetchContextGraphs()).toEqual(rows('new'));
    expect(listCalls()).toBe(2);
  } finally {
    pending.forEach(resolve => resolve(json(rows('cleanup'))));
    await act(async () => { await retry; });
  }
});

it('two inventory consumers share one membership-event subscription until the last unmount', async () => {
  const events = await import('../src/ui/hooks/useNodeEvents.js');
  const subscribe = vi.spyOn(events, 'subscribeNodeEvents');
  await mount(2);
  expect(subscribe).toHaveBeenCalledTimes(1);
  await act(async () => { Events.current.emit('join_approved'); });
  expect(listCalls()).toBe(2);
  await act(async () => { Events.current.emit('notification'); });
  expect(listCalls()).toBe(2);
  await act(async () => root!.unmount()); root = null;
  expect(Events.current.close).toHaveBeenCalledTimes(1);
  await act(async () => { Events.current.emit('project_synced'); });
  expect(listCalls()).toBe(2);
});


it('staggered Header and inventory mounts share one identity cadence until the final owner unmounts', async () => {
  const { useCurrentAgent } = await import('../src/ui/hooks/useCurrentAgent.js');
  const { useContextGraphInventory } = await import('../src/ui/hooks/useContextGraphInventory.js');
  const identityCalls = () => http.mock.calls.filter(([url]) => url === '/api/agent/identity').length;
  function Header() { useCurrentAgent(); return null; }
  function Inventory() { useContextGraphInventory(); return null; }
  const render = async (header: boolean, inventory: boolean) => act(async () => root!.render(
    React.createElement(React.Fragment, {}, header && React.createElement(Header, { key: 'header' }),
      inventory && React.createElement(Inventory, { key: 'inventory' }))));
  await render(true, false);
  expect(identityCalls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  await render(true, true);
  expect(identityCalls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(identityCalls()).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(identityCalls()).toBe(2); // inventory's :20 poll does not refresh identity
  await render(false, true);
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(identityCalls()).toBe(3); // the composed inventory identity hook keeps the :00 cadence
  await render(false, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(identityCalls()).toBe(3);
});


it.each(['list', 'identity'])('composed inventory reports %s failure and recovery while retaining both snapshots', async endpoint => {
  const { useContextGraphInventory, refreshContextGraphInventory } = await import('../src/ui/hooks/useContextGraphInventory.js');
  let inventory!: ReturnType<typeof useContextGraphInventory>;
  function Probe() { inventory = useContextGraphInventory(); return null; }
  await act(async () => { root!.render(React.createElement(Probe)); });
  expect(inventory.identity.data).toEqual(agent);
  expect(inventory.contextGraphs).toEqual(rows('healthy').contextGraphs);
  expect(inventory.inventoryLoading).toBe(false);
  expect(inventory.inventoryError).toBeNull();

  let release!: (response: Response) => void;
  const failedRead = () => new Promise<Response>(resolve => { release = resolve; });
  if (endpoint === 'list') list = failedRead;
  else identity = failedRead;
  let retry!: Promise<unknown>;
  await act(async () => { retry = refreshContextGraphInventory(true); });
  expect(inventory.inventoryLoading).toBe(true);
  expect(inventory.identity.data).toEqual(agent);
  expect(inventory.contextGraphs).toEqual(rows('healthy').contextGraphs);
  await act(async () => {
    release(new Response(JSON.stringify({ error: `${endpoint} unavailable` }), { status: 503 }));
    await retry;
  });
  expect(inventory.inventoryLoading).toBe(false);
  expect(inventory.inventoryError).toBe(`${endpoint} unavailable`);
  expect(inventory.error).toBe(endpoint === 'list' ? 'list unavailable' : null);
  expect(inventory.identity.error).toBe(endpoint === 'identity' ? 'identity unavailable' : null);
  expect(inventory.identity.data).toEqual(agent);
  expect(inventory.contextGraphs).toEqual(rows('healthy').contextGraphs);

  list = async () => json(rows('recovered'));
  identity = async () => json({ ...agent, peerId: 'recovered-peer' });
  await act(async () => { await refreshContextGraphInventory(true); });
  expect(inventory.inventoryError).toBeNull();
  expect(inventory.inventoryLoading).toBe(false);
  expect(inventory.contextGraphs).toEqual(rows('recovered').contextGraphs);
  expect(inventory.identity.data?.peerId).toBe('recovered-peer');
});
