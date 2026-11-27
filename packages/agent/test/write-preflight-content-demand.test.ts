import { describe, expect, it, vi } from 'vitest';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { probeContextGraphWritePreflight } from '../src/context-graph-write-preflight.js';

const metaGraph = contextGraphMetaGraphUri('owner/graph');
const caller = '0x2222222222222222222222222222222222222222';
const options = { callerAgentAddress: caller, contentCheck: 'when-needed-for-write' as const };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const host = {
    contextGraphExists: vi.fn(async () => true),
    contextGraphHasLocalContent: vi.fn(async () => true),
    store: { query: vi.fn(async () => ({ type: 'bindings' as const, bindings: [
      { sourceGraph: metaGraph, kind: 'declared' }, { sourceGraph: metaGraph, kind: 'access', value: 'public' },
    ] })) },
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: vi.fn(async () => true),
  };
  const subscriptions = {
    store: { load: vi.fn(async () => null) },
    current: vi.fn(() => ({ subscribed: true, synced: true })),
  };
  return { host, subscriptions };
}

describe('write preflight content demand', () => {
  it('does not start content discovery when fresh facts and a synced subscription suffice', async () => {
    const { host, subscriptions } = fixture();
    const content = deferred<boolean>();
    host.contextGraphHasLocalContent.mockImplementation(() => content.promise);
    const pending = probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    try {
      // Every other dependency is already resolved. A turn of the event loop
      // distinguishes a finished probe from one waiting on deferred content.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(host.contextGraphHasLocalContent).not.toHaveBeenCalled();
      const result = await pending;
      expect(result).toMatchObject({ storeAvailable: true, exists: true,
        declarationFound: true, callerAuthorized: true,
        inMemorySubscription: { subscribed: true, synced: true } });
      expect(result).not.toHaveProperty('hasLocalContent');
    } finally {
      content.resolve(true);
      await pending;
    }
  });
  it('keeps the default full probe and actual content value', async () => {
    const { host, subscriptions } = fixture();
    host.contextGraphHasLocalContent.mockResolvedValue(false);
    const result = await probeContextGraphWritePreflight(host, subscriptions, 'owner/graph');
    expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
    expect(result.hasLocalContent).toBe(false);
  });

  it.each(['existence', 'declaration', 'subscription'] as const)(
    'never hides a failed %s read in writability mode', async (site) => {
      const { host, subscriptions } = fixture();
      const error = new Error('unavailable');
      if (site === 'existence') host.contextGraphExists.mockRejectedValue(error);
      if (site === 'declaration') host.store.query.mockRejectedValue(error);
      if (site === 'subscription') subscriptions.store.load.mockRejectedValue(error);
      const result = await probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
      expect(result.storeAvailable).toBe(false);
      expect(result.failureAttribution).toContainEqual({ site, kind: 'unknown' });
      expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
    });

  it.each(['unsynced', 'unsubscribed', 'nonexistent', 'undeclared', 'unknown-policy'])(
    'retains content discovery for %s graphs', async (state) => {
      const { host, subscriptions } = fixture();
      if (state === 'unsynced') subscriptions.current.mockReturnValue({ subscribed: true, synced: false });
      if (state === 'unsubscribed') subscriptions.current.mockReturnValue({ subscribed: false, synced: true });
      if (state === 'nonexistent') host.contextGraphExists.mockResolvedValue(false);
      if (state === 'undeclared') host.store.query.mockResolvedValue({ type: 'bindings', bindings: [{ sourceGraph: metaGraph, kind: 'access', value: 'public' }] });
      if (state === 'unknown-policy') host.store.query.mockResolvedValue({ type: 'bindings', bindings: [{ sourceGraph: metaGraph, kind: 'declared' }] });
      await probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
      expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
    });

  it.each([true, false])('preserves private caller authorization=%s', async (authorized) => {
    const { host, subscriptions } = fixture();
    host.store.query.mockResolvedValue({ type: 'bindings', bindings: [
      { sourceGraph: metaGraph, kind: 'declared' }, { sourceGraph: metaGraph, kind: 'access', value: 'private' },
    ] });
    host.callerIsAllowlistedAgentParticipant.mockResolvedValue(authorized);
    const result = await probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    expect(result.callerAuthorized).toBe(authorized);
    expect(result.accessPolicy).toBe('private');
    expect(host.callerIsAllowlistedAgentParticipant).toHaveBeenCalledTimes(1);
    expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(authorized ? 0 : 1);
  });

  it('does not retain an earlier synced snapshot across caller authorization', async () => {
    const { host, subscriptions } = fixture();
    const allow = deferred<boolean>();
    host.store.query.mockResolvedValue({ type: 'bindings', bindings: [
      { sourceGraph: metaGraph, kind: 'declared' }, { sourceGraph: metaGraph, kind: 'access', value: 'private' },
    ] });
    host.callerIsAllowlistedAgentParticipant.mockImplementation(() => allow.promise);
    const pending = probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    subscriptions.current.mockReturnValue({ subscribed: true, synced: false });
    allow.resolve(true);
    const result = await pending;
    expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
    expect(result.inMemorySubscription).toEqual({ subscribed: true, synced: false });
  });

  it('copies the current subscription after deferred fallback content settles', async () => {
    const { host, subscriptions } = fixture();
    subscriptions.current.mockReturnValue({ subscribed: true, synced: false });
    const content = deferred<boolean>();
    host.contextGraphHasLocalContent.mockImplementation(() => content.promise);
    const pending = probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    subscriptions.current.mockReturnValue({ subscribed: false, synced: false });
    content.resolve(false);
    const result = await pending;
    expect(result.inMemorySubscription).toEqual({ subscribed: false, synced: false });
    expect(result.hasLocalContent).toBe(false);
  });

  it('retains fallback content errors as unknown and unavailable', async () => {
    const { host, subscriptions } = fixture();
    subscriptions.current.mockReturnValue({ subscribed: true, synced: false });
    host.contextGraphHasLocalContent.mockRejectedValue(new Error('read failed'));
    const result = await probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    expect(result.storeAvailable).toBe(false);
    expect(result).not.toHaveProperty('hasLocalContent');
    expect(result.failureAttribution).toContainEqual({ site: 'content', kind: 'unknown' });
  });

  it('rechecks the subscription after a pending metadata read', async () => {
    const { host, subscriptions } = fixture();
    const metadata = deferred<Awaited<ReturnType<typeof host.store.query>>>();
    host.store.query.mockImplementation(() => metadata.promise);
    const pending = probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    subscriptions.current.mockReturnValue({ subscribed: false, synced: false });
    metadata.resolve({ type: 'bindings', bindings: [
      { sourceGraph: metaGraph, kind: 'declared' }, { sourceGraph: metaGraph, kind: 'access', value: 'public' },
    ] });
    const result = await pending;
    expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
    expect(result.inMemorySubscription).toEqual({ subscribed: false, synced: false });
  });

  it('does not hide unavailable private authorization', async () => {
    const { host, subscriptions } = fixture();
    host.store.query.mockResolvedValue({ type: 'bindings', bindings: [
      { sourceGraph: metaGraph, kind: 'declared' }, { sourceGraph: metaGraph, kind: 'access', value: 'private' },
    ] });
    host.callerIsAllowlistedAgentParticipant.mockRejectedValue(new Error('policy unavailable'));
    const result = await probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    expect(result.storeAvailable).toBe(false);
    expect(result).not.toHaveProperty('callerAuthorized');
    expect(result.failureAttribution).toContainEqual({ site: 'caller-access', kind: 'unknown' });
    expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
  });

  it('does not treat a public policy from the shared agents graph as authority', async () => {
    const { host, subscriptions } = fixture();
    host.store.query.mockResolvedValue({ type: 'bindings', bindings: [
      { sourceGraph: metaGraph, kind: 'declared' },
      { sourceGraph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS), kind: 'access', value: 'public' },
    ] });
    const result = await probeContextGraphWritePreflight(host, subscriptions, 'owner/graph', options);
    expect(result).not.toHaveProperty('accessPolicy');
    expect(result).not.toHaveProperty('callerAuthorized');
    expect(host.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
  });

});
