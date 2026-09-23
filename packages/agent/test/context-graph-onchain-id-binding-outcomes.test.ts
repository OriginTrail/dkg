import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_ID,
  NAME_HASH,
  proveOnChainSlot,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

/**
 * A locally indexed Context Graph whose durable binding cannot be trusted --
 * either because the persisted `onChainId` is present but not a canonical
 * chain slot, or because the subscription is no longer locally admitted and
 * therefore has no name commitment to enumerate -- must resolve through the
 * bounded strict fallback owned by `resolveContextGraphOnChainIdBinding()`.
 *
 * These scenarios pin the three terminal outcomes of that bounded call:
 * a projected `registered` binding, a distinct `unregistered` absence, and a
 * fail-closed `unavailable` that surfaces the failing dependency instead of
 * being downgraded to absence.
 */
describe('Context Graph registration binding: strict on-chain id fallback outcomes', () => {
  it('projects the ontology fallback id into a registered binding with its provenance', async () => {
    const fixture = selectedFixture();
    // Present but non-canonical: the durable value can no longer act as an
    // authoritative binding, so the zero-RPC fast path must not claim it.
    fixture.subscription.onChainId = '0';
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ id: '"77"' }],
    });
    proveOnChainSlot(fixture, '77');

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 77n,
        provenance: 'ontology',
      });

    // The read must be attributed to the registration-binding call site.
    expect(fixture.query.mock.calls.some(([, options]) =>
      options?.source === 'agent.contextGraph.registrationBinding'
    )).toBe(true);
    // An invalid durable id must fail closed to the ontology fallback and must
    // never be silently replaced by reverse name-hash discovery.
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('projects the fallback id without losing precision above Number.MAX_SAFE_INTEGER', async () => {
    const fixture = selectedFixture();
    fixture.subscription.onChainId = 'not-a-chain-slot';
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ id: '"9007199254740993"' }],
    });
    proveOnChainSlot(fixture, '9007199254740993');

    const binding = await fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID);

    expect(binding).toEqual({
      kind: 'registered',
      onChainId: 9007199254740993n,
      provenance: 'ontology',
    });
    // A float round-trip would have collapsed this slot onto ...992, so the
    // exact match above is the precision proof.
  });

  it('routes an unadmitted subscription with no name commitment through the same fallback', async () => {
    const fixture = selectedFixture();
    // No local admission => no curator commitment to enumerate on chain.
    fixture.subscription.subscribed = false;
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ id: '"5"' }],
    });
    proveOnChainSlot(fixture, '5');

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 5n,
        provenance: 'ontology',
      });
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('never projects an ontology id this chain does not prove, and takes the one it does', async () => {
    // The ontology graph holds every network's claims. Neither an id this
    // node has no chain facts for, nor one whose slot commits another name,
    // binds anything.
    for (const facts of [undefined, `0x${'cd'.repeat(32)}`]) {
      const fixture = selectedFixture();
      fixture.subscription.onChainId = '0';
      fixture.query.mockResolvedValueOnce({ type: 'bindings', bindings: [{ id: '"33"' }] });
      if (facts !== undefined) proveOnChainSlot(fixture, '33', facts);

      await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
        .resolves.toMatchObject({ kind: 'unregistered' });
    }

    // Several claims for one subject: the proven one wins whatever its order.
    const fixture = selectedFixture();
    fixture.subscription.onChainId = '0';
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ id: '"91"' }, { id: 7 as unknown as string }, { id: '"12"' }],
    });
    proveOnChainSlot(fixture, '91', `0x${'cd'.repeat(32)}`);
    proveOnChainSlot(fixture, '12');
    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({ kind: 'registered', onChainId: 12n, provenance: 'ontology' });
  });

  it('stays registered however many other claims the subject carries', async () => {
    // Claims #1..#40 from other networks, then this chain's #41. A store
    // answers an unfiltered read with some page of them (here, the first 16);
    // only a read that asks for the proven id is sure to see it.
    const claims = Array.from({ length: 41 }, (_, index) => String(index + 1));
    const fixture = selectedFixture();
    fixture.subscription.onChainId = '0';
    fixture.query.mockImplementation(async (sparql: string) => {
      const filter = /IN \(([^)]*)\)/.exec(sparql)?.[1];
      const page = filter === undefined
        ? claims.slice(0, 16)
        : claims.filter((id) => filter.includes(JSON.stringify(id)));
      return { type: 'bindings', bindings: page.map((id) => ({ id: `"${id}"` })) };
    });
    proveOnChainSlot(fixture, '41');

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({ kind: 'registered', onChainId: 41n, provenance: 'ontology' });
  });

  it('keeps a genuine absence reported as unregistered rather than unavailable', async () => {
    const fixture = selectedFixture();
    fixture.subscription.onChainId = '0';
    // The chain proves a slot, but no ontology claim names it.
    proveOnChainSlot(fixture, '77');
    fixture.query.mockResolvedValueOnce({ type: 'bindings', bindings: [] });

    const binding = await fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID);

    expect(binding).toEqual({ kind: 'unregistered' });
    expect(binding).not.toHaveProperty('reason');
    expect(binding).not.toHaveProperty('onChainId');
  });

  it('surfaces a failing fallback dependency as unavailable with its message', async () => {
    const fixture = selectedFixture();
    fixture.subscription.onChainId = '0';
    // A claim can count only for a proven slot, so there is a read to fail.
    proveOnChainSlot(fixture, '77');
    fixture.query.mockRejectedValueOnce(new Error('oxigraph store is unreachable'));

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
        detail: 'oxigraph store is unreachable',
      });
  });

  it('stringifies a non-Error fallback rejection into the unavailable detail', async () => {
    const fixture = selectedFixture();
    fixture.subscription.onChainId = '0';
    proveOnChainSlot(fixture, '77');
    fixture.query.mockRejectedValueOnce('rpc socket closed');

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
        detail: 'rpc socket closed',
      });
  });

  it('fails closed when a stale reverse candidate can no longer be revalidated', async () => {
    const fixture = selectedFixture();
    fixture.agent.bindSubscriptionReverseNameHashOnChainId(
      LOCAL_ID,
      fixture.subscription,
      '42',
      NAME_HASH,
    );
    // Local admission is withdrawn, so the commitment that produced the
    // candidate can no longer be re-enumerated.
    fixture.subscription.subscribed = false;

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
        detail: `Context Graph "${LOCAL_ID}" reverse binding can no longer be revalidated`,
      });
    // A stale candidate must not fall through to the ontology fallback.
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it('converts a bounded fallback timeout into unavailable and cancels the in-flight read', async () => {
    vi.useFakeTimers();
    try {
      const fixture = selectedFixture();
      fixture.subscription.onChainId = '0';
      proveOnChainSlot(fixture, '77');
      let capturedSignal: AbortSignal | undefined;
      fixture.query.mockImplementation((_sparql, options) => {
        capturedSignal = options?.signal;
        return new Promise<never>(() => {});
      });

      const pending = fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
        registrationTimeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(capturedSignal?.aborted).toBe(true);

      await expect(pending).resolves.toEqual({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
        detail: `resolveContextGraphOnChainIdBinding(${LOCAL_ID}) timed out after 1000ms`,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
