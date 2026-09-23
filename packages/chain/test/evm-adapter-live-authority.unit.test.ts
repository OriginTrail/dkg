// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { ContextGraphLiveAuthorityUnsupportedError } from '../src/chain-adapter.js';
import { CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER } from
  '../src/context-graph-authority-rpc-sites.js';
import { fixture } from './context-graph-name-hash-reverse-resolution.fixtures.js';

const MEMBER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const NONEXISTENT = new ethers.Interface(['error ERC721NonexistentToken(uint256 tokenId)']);
const AUTHORITY = { active: true, accessPolicy: 1, participantAgents: [MEMBER] };
const TUPLE = { active: true, accessPolicy: 1n, participantAgents: [MEMBER] };

function callException(overrides: Record<string, unknown>): Error {
  return Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', ...overrides });
}

describe('EVM adapter: one-read live context graph authority', () => {
  it('runs the identity-binding name-hash read under the bounded security-gate policy', async () => {
    const { adapter, readContractWithOptions } = fixture();

    await expect(adapter.getContextGraphNameHash(1n)).resolves.toBeTruthy();
    const [, label, method, args, options] = readContractWithOptions.mock.calls[0];
    expect(label).toBe('cgStorage.getNameHash');
    expect(method).toBe('getNameHash');
    expect(args).toEqual([1n]);
    expect(options.policy).toBe('securityGatePointRead');
  });

  it('issues exactly one getContextGraph read and decodes the named tuple', async () => {
    const { adapter, readContractWithOptions } = fixture();
    readContractWithOptions.mockImplementation(async (_c: unknown, _l: string, method: string) => {
      if (method !== 'getContextGraph') throw new Error(`unexpected ${method}`);
      return { active: true, accessPolicy: 1n, participantAgents: [MEMBER] };
    });

    await expect(adapter.getContextGraphLiveAuthority(7n)).resolves.toEqual({
      active: true,
      accessPolicy: 1,
      participantAgents: [MEMBER],
    });
    expect(readContractWithOptions).toHaveBeenCalledTimes(1);
    expect(readContractWithOptions.mock.calls[0][2]).toBe('getContextGraph');
  });

  it('forwards the id, and runs the read on the FLIGHT\'s signal, not the caller\'s', async () => {
    const { adapter, readContractWithOptions } = fixture();
    readContractWithOptions.mockResolvedValue({ active: true, accessPolicy: 0n, participantAgents: [] });
    const { signal } = new AbortController();

    await adapter.getContextGraphLiveAuthority(7n, { signal });
    const [, label, method, args, options] = readContractWithOptions.mock.calls[0];
    expect(label).toBe(CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER);
    expect(method).toBe('getContextGraph');
    expect(args).toEqual([7n]);
    expect(options.policy).toBe('securityGatePointRead');
    // The read is shared, so it belongs to the flight: one caller abandoning
    // its wait must not cancel it for the others. The caller's own signal only
    // detaches that caller (see the abandonment case below).
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal).not.toBe(signal);
  });

  it('shares ONE read between callers of the same turn, and retains nothing after it', async () => {
    const { adapter, readContractWithOptions } = fixture();
    readContractWithOptions.mockResolvedValue({ active: true, accessPolicy: 1n, participantAgents: [MEMBER] });

    const together = await Promise.all(
      Array.from({ length: 20 }, () => adapter.getContextGraphLiveAuthority(7n)),
    );
    expect(readContractWithOptions).toHaveBeenCalledTimes(1);
    for (const authority of together) {
      expect(authority).toEqual({ active: true, accessPolicy: 1, participantAgents: [MEMBER] });
    }

    // Nothing is kept: each serial caller is a fresh live read. This is the
    // kill-switch equivalence — remove the sharing and the counts are these.
    readContractWithOptions.mockClear();
    for (let i = 0; i < 5; i += 1) await adapter.getContextGraphLiveAuthority(7n);
    expect(readContractWithOptions).toHaveBeenCalledTimes(5);

    // A different id is a different flight, always.
    readContractWithOptions.mockClear();
    await Promise.all([
      adapter.getContextGraphLiveAuthority(7n),
      adapter.getContextGraphLiveAuthority(8n),
    ]);
    expect(readContractWithOptions).toHaveBeenCalledTimes(2);
  });

  // The two cases below drive `getContextGraphLiveAuthority` rather than the
  // coalescer, because the properties they pin live in the ADAPTER's wiring —
  // the `isDefinitiveError` predicate and the flight key. A coalescer test
  // injects both, so it proves nothing about the pair that ships underneath a
  // security gate.

  it('#2666: a joiner inherits neither the initiator\'s transient failure nor its abort', async () => {
    // What may cross callers is decided by the production predicate in
    // `evm-adapter-base.ts`: ONLY the deterministic "this read cannot answer"
    // fault. Both shapes below are indefinite, so they are the initiator's own.
    for (const failure of [
      // A transport interruption. Another read may well succeed.
      Object.assign(new Error('socket hang up'), { code: 'SERVER_ERROR' }),
      // An abort raised BELOW the flight (an endpoint pool torn down mid-call).
      // The flight's own signal is still clear, so the loader rethrows it as-is
      // and it reaches the predicate looking exactly like a verdict.
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    ]) {
      const f = fixture();
      f.readContractWithOptions.mockRejectedValueOnce(failure).mockResolvedValue(TUPLE);

      const initiator = f.adapter.getContextGraphLiveAuthority(7n);
      const initiatorSettled = initiator.catch((error: unknown) => error);
      const joiners = [0, 1].map(() => f.adapter.getContextGraphLiveAuthority(7n));

      // Identity, not shape: the initiator owns the failure of the read it
      // started, un-reclassified.
      await expect(initiatorSettled).resolves.toBe(failure);
      // And nobody else is ever answered by it. #2666 shipped the opposite.
      for (const joiner of joiners) await expect(joiner).resolves.toEqual(AUTHORITY);

      // Two reads, not four: the joiners re-read through ONE successor.
      expect(f.readContractWithOptions).toHaveBeenCalledTimes(2);
      // A successor FLIGHT, not a retry inside the failed one — so the re-read
      // does not run on a controller the first read may already have poisoned.
      expect(f.readContractWithOptions.mock.calls[1][4].signal)
        .not.toBe(f.readContractWithOptions.mock.calls[0][4].signal);
    }
  });

  it('shares the production predicate\'s definitive unsupported error', async () => {
    const f = fixture();
    const failure = new ContextGraphLiveAuthorityUnsupportedError('tuple layout');
    f.readContractWithOptions.mockRejectedValue(failure);

    const settled = await Promise.all([
      f.adapter.getContextGraphLiveAuthority(7n).catch((error: unknown) => error),
      f.adapter.getContextGraphLiveAuthority(7n).catch((error: unknown) => error),
    ]);

    expect(settled[0]).toBe(settled[1]);
    expect(settled[0]).toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);
    expect((settled[0] as Error & { cause?: unknown }).cause).toBe(failure);
    expect(f.readContractWithOptions).toHaveBeenCalledTimes(1);
  });

  it('partitions flights by the CONTRACT bound now, never by the bare numeric id', async () => {
    const f = fixture();
    f.readContractWithOptions.mockResolvedValue(TUPLE);
    // ContextGraphStorage hands out ids sequentially, so id 7 exists in every
    // deployment and names a different graph in each. The adapter reads the
    // bound address per call — a Hub rotation rebinds the contract — so two
    // same-turn callers can legitimately be asking two different contracts for
    // id 7. Sharing there would answer one deployment's gate with another
    // deployment's roster.
    const bound = ['0x00000000000000000000000000000000000000c6',
      '0x00000000000000000000000000000000000000d7'];
    let nth = 0;
    const getAddress = vi.fn(async () => bound[nth++] ?? bound[1]);
    f.adapter.contracts.contextGraphStorage.getAddress = getAddress;

    await Promise.all([
      f.adapter.getContextGraphLiveAuthority(7n),
      f.adapter.getContextGraphLiveAuthority(7n),
    ]);
    // Exactly one address read per caller, so the two callers demonstrably saw
    // the two DIFFERENT contracts above rather than the same one twice.
    expect(getAddress).toHaveBeenCalledTimes(2);
    expect(f.readContractWithOptions).toHaveBeenCalledTimes(2);

    // Control, same turn, same everything: ONE read. Without it the count above
    // would read the same whether the key carried the lineage or the callers
    // simply never shared anything.
    f.readContractWithOptions.mockClear();
    await Promise.all([
      f.adapter.getContextGraphLiveAuthority(7n),
      f.adapter.getContextGraphLiveAuthority(7n),
    ]);
    expect(f.readContractWithOptions).toHaveBeenCalledTimes(1);
  });

  it('partitions flights by DEPLOYMENT too: one address on two chains is two graphs', async () => {
    const f = fixture();
    f.readContractWithOptions.mockResolvedValue(TUPLE);
    // A reproducible deployment puts the SAME ContextGraphStorage address on
    // several chains, so the address alone does not separate them; chainId +
    // Hub does. Read per caller, exactly as the adapter reads it.
    const deployments = ['evm:31337:hub=0x0000000000000000000000000000000000000001',
      'evm:31338:hub=0x0000000000000000000000000000000000000001'];
    let nth = 0;
    Object.defineProperty(f.adapter, 'deploymentId', {
      configurable: true,
      get: () => deployments[nth++] ?? deployments[1],
    });

    await Promise.all([
      f.adapter.getContextGraphLiveAuthority(7n),
      f.adapter.getContextGraphLiveAuthority(7n),
    ]);
    expect(f.readContractWithOptions).toHaveBeenCalledTimes(2);
    // One read of the getter per caller. If another line on this path ever
    // starts reading it, the count above stops meaning what it names — so pin
    // it, after the property rather than in front of it.
    expect(nth).toBe(2);
  });

  it('gives one caller\'s abort to that caller alone; peers keep the shared read', async () => {
    const { adapter, readContractWithOptions } = fixture();
    let release!: (value: unknown) => void;
    readContractWithOptions.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const leaving = new AbortController();
    const abandoned = adapter.getContextGraphLiveAuthority(7n, { signal: leaving.signal });
    const stays = adapter.getContextGraphLiveAuthority(7n);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(readContractWithOptions).toHaveBeenCalledTimes(1);

    leaving.abort(new Error('caller stopped'));
    await expect(abandoned).rejects.toThrow('caller stopped');
    // The abandoning caller did not cancel the read for the one still waiting.
    expect(readContractWithOptions.mock.calls[0][4].signal.aborted).toBe(false);
    release({ active: true, accessPolicy: 1n, participantAgents: [MEMBER] });
    await expect(stays).resolves.toEqual({
      active: true, accessPolicy: 1, participantAgents: [MEMBER],
    });
  });

  it('decodes the positional tuple shape ethers may hand back', async () => {
    const { adapter, readContractWithOptions } = fixture();
    // (owner, participantAgents, metadataBatchId, active, createdAt, accessPolicy, publishPolicy, ...)
    // Every slot holds a DIFFERENT value, so reading a neighbouring index
    // cannot produce the right answer by coincidence.
    readContractWithOptions.mockResolvedValue([OTHER, [MEMBER, OTHER], 9n, true, 1234n, 1n, 0n, OTHER, 77n]);

    await expect(adapter.getContextGraphLiveAuthority(7n)).resolves.toEqual({
      active: true,
      accessPolicy: 1,
      participantAgents: [MEMBER, OTHER],
    });
  });

  it('resolves null ONLY for a proven-nonexistent id, by decoded name or by exact bytes', async () => {
    const byName = fixture();
    byName.readContractWithOptions.mockRejectedValue(
      callException({ revert: { name: 'ERC721NonexistentToken', args: [7n] } }),
    );
    await expect(byName.adapter.getContextGraphLiveAuthority(7n)).resolves.toBeNull();

    const byBytes = fixture();
    byBytes.readContractWithOptions.mockRejectedValue(
      callException({ data: NONEXISTENT.encodeErrorResult('ERC721NonexistentToken', [7n]) }),
    );
    await expect(byBytes.adapter.getContextGraphLiveAuthority(7n)).resolves.toBeNull();

    // The same error for a DIFFERENT id is not proof about this one: never
    // `null`. It is a revert that answers nothing, so the point reads decide.
    const otherId = fixture();
    otherId.readContractWithOptions.mockRejectedValue(
      callException({ data: NONEXISTENT.encodeErrorResult('ERC721NonexistentToken', [8n]) }),
    );
    await expect(otherId.adapter.getContextGraphLiveAuthority(7n))
      .rejects.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);
  });

  it('sends every failure the package does NOT classify as retryable to the point reads', async () => {
    // No private reading of provider strings: whatever the package classifies
    // as non-retryable for a view lands here, whichever node produced it. (The
    // first shape is also what ethers makes of a JSON-RPC error body, so a
    // throttling node lands here too: one extra read, same final disposition.)
    for (const failure of [
      // geth: no revert payload at all
      Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null, reason: null }),
      // Hardhat / nodes that echo empty revert data
      Object.assign(new Error('execution reverted (no data present; likely require(false) occurred'), {
        code: 'CALL_EXCEPTION', data: '0x', reason: 'require(false)',
      }),
      // a revert that carries a reason but says nothing about this id
      callException({ reason: 'Paused' }),
      // empty return
      Object.assign(new Error('could not decode result data (value="0x", info=...)'), { code: 'BAD_DATA' }),
      // the shape a real tuple-layout mismatch produces: a NON-empty payload
      Object.assign(new Error('could not decode result data (value="0x0000000000000001", info=...)'), {
        code: 'BAD_DATA',
      }),
    ]) {
      const f = fixture();
      f.readContractWithOptions.mockRejectedValue(failure);
      const rejection = f.adapter.getContextGraphLiveAuthority(7n);
      await expect(rejection).rejects.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);
      // The original error travels as `cause`, so whoever reads the fallback
      // warning can still get at what the node actually said.
      await expect(rejection).rejects.toHaveProperty('cause', failure);
    }
  });

  it('propagates every TRANSIENT failure as the very same error, never as a cue for more reads', async () => {
    // Identity, not message: the unsupported wrapper quotes the original
    // message, so a message match would pass on a wrongly wrapped error too.
    for (const failure of [
      Object.assign(new Error('socket hang up'), { code: 'SERVER_ERROR' }),
      Object.assign(new Error('request timed out'), { code: 'TIMEOUT' }),
      // Local governor saturation and an exhausted endpoint set are
      // retry-LATER: three more reads is the one wrong answer to them.
      Object.assign(new Error('rpc request queue is full'), { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' }),
      Object.assign(new Error('all endpoints failed'), { code: 'RPC_ENDPOINTS_EXHAUSTED' }),
    ]) {
      const f = fixture();
      f.readContractWithOptions.mockRejectedValue(failure);
      await expect(f.adapter.getContextGraphLiveAuthority(7n)).rejects.toBe(failure);
    }
  });

  it('returns each cancelled waiter\'s exact abort reason, regardless of the shared read outcome', async () => {
    // Coalesced waiters detach with their own abort reason. The shared loader
    // may settle later with a classifiable error, but that result must not
    // replace the reason observed by a caller that already cancelled.
    const looksUnsupported = fixture();
    const bare = Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null, reason: null });
    let releaseBare!: (reason: unknown) => void;
    looksUnsupported.readContractWithOptions.mockImplementation(
      () => new Promise((_resolve, reject) => { releaseBare = reject; }),
    );
    const cancelling = new AbortController();
    const firstAbortReason = new Error('caller stopped');
    const first = looksUnsupported.adapter.getContextGraphLiveAuthority(7n, { signal: cancelling.signal });
    const firstSettled = first.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancelling.abort(firstAbortReason);
    releaseBare(bare);
    await expect(firstSettled).resolves.toBe(firstAbortReason);

    const looksNonexistent = fixture();
    const revert = callException({ revert: { name: 'ERC721NonexistentToken', args: [7n] } });
    let releaseRevert!: (reason: unknown) => void;
    looksNonexistent.readContractWithOptions.mockImplementation(
      () => new Promise((_resolve, reject) => { releaseRevert = reject; }),
    );
    const cancellingToo = new AbortController();
    const secondAbortReason = new Error('caller stopped too');
    const second = looksNonexistent.adapter.getContextGraphLiveAuthority(7n, { signal: cancellingToo.signal });
    const secondSettled = second.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancellingToo.abort(secondAbortReason);
    releaseRevert(revert);
    await expect(secondSettled).resolves.toBe(secondAbortReason);

    // An ALREADY-aborted caller never reaches the chain at all now: it is
    // never answered by a read it did not ask for, so there is nothing to
    // classify.
    const neverRead = fixture();
    const preAborted = AbortSignal.abort(new Error('caller stopped before asking'));
    await expect(neverRead.adapter.getContextGraphLiveAuthority(7n, { signal: preAborted }))
      .rejects.toThrow('caller stopped before asking');
    expect(neverRead.readContractWithOptions).not.toHaveBeenCalled();
  });

  it('is id-exact on the DECODED revert too: another token proves nothing about this one', async () => {
    const otherIdByName = fixture();
    otherIdByName.readContractWithOptions.mockRejectedValue(
      callException({ revert: { name: 'ERC721NonexistentToken', args: [8n] } }),
    );
    // Resolving null here would be TERMINAL: a live graph reported as gone forever.
    await expect(otherIdByName.adapter.getContextGraphLiveAuthority(7n))
      .rejects.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);

    for (const args of [undefined, [], ['not-a-number']]) {
      const malformed = fixture();
      malformed.readContractWithOptions.mockRejectedValue(
        callException({ revert: { name: 'ERC721NonexistentToken', args } }),
      );
      await expect(malformed.adapter.getContextGraphLiveAuthority(7n))
        .rejects.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);
    }
  });

  it('reports an undecodable tuple as unsupported, so the point reads decide', async () => {
    for (const tuple of [
      { active: 'yes', accessPolicy: 1n, participantAgents: [] },          // non-boolean liveness
      { active: true, accessPolicy: 'garbage', participantAgents: [] },    // non-numeric policy
      { active: true, accessPolicy: 1n, participantAgents: 'nope' },       // non-array roster
      { active: true, participantAgents: [] },                             // missing policy
    ]) {
      const f = fixture();
      f.readContractWithOptions.mockResolvedValue(tuple);
      await expect(f.adapter.getContextGraphLiveAuthority(7n))
        .rejects.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);
    }
  });

  it('hands roster entries through as read; validating them is the resolver job', async () => {
    const f = fixture();
    f.readContractWithOptions.mockResolvedValue({
      active: true, accessPolicy: 1n, participantAgents: ['did:dkg:agent:wrong', MEMBER],
    });
    // Throwing on a bad entry here would surface as the RETRYABLE
    // policy-unavailable reason; the resolver turns it into the terminal
    // `chain-participant-authority-invalid` instead.
    await expect(f.adapter.getContextGraphLiveAuthority(7n)).resolves.toEqual({
      active: true, accessPolicy: 1, participantAgents: ['did:dkg:agent:wrong', MEMBER],
    });
  });
});

/**
 * `getContextGraphAccessPolicy` falls back to the same `getContextGraph` tuple
 * when `getAccessPolicy` fails, and reads it through the SAME positional map as
 * the one-read decoder above. Pinned here so the two cannot drift apart.
 */
describe('EVM adapter: access-policy fallback shares the getContextGraph tuple layout', () => {
  function failingPrimary(tuple: unknown) {
    const f = fixture();
    f.readContractWithOptions.mockImplementation(async (_c: unknown, _l: string, method: string) => {
      if (method === 'getAccessPolicy') throw new Error('getAccessPolicy unavailable');
      if (method === 'getContextGraph') return tuple;
      throw new Error(`unexpected ${method}`);
    });
    return f;
  }

  it('reads the policy from the positional slot, with a distinct value in every slot', async () => {
    const { adapter } = failingPrimary([OTHER, [MEMBER, OTHER], 9n, true, 1234n, 1n, 0n, OTHER, 77n]);
    await expect(adapter.getContextGraphAccessPolicy(7n)).resolves.toBe(1);
  });

  it('prefers the named field when ethers supplies one', async () => {
    const { adapter } = failingPrimary({ accessPolicy: 1n });
    await expect(adapter.getContextGraphAccessPolicy(7n)).resolves.toBe(1);
  });

  it('reports both failures when the tuple carries no policy at all', async () => {
    const { adapter } = failingPrimary({});
    await expect(adapter.getContextGraphAccessPolicy(7n)).rejects.toThrow(
      /getAccessPolicy unavailable.*returned no accessPolicy field/s,
    );
  });
});

describe('EVM adapter: bounded-freshness live authority', () => {
  const INDEX_ANSWER = Object.freeze({
    active: true, accessPolicy: 1, participantAgents: [OTHER],
  });

  function boundedFixture(options: { enabled: boolean; peek?: unknown }) {
    const { adapter, readContractWithOptions } = fixture();
    readContractWithOptions.mockImplementation(async (_c: unknown, _l: string, method: string) => {
      if (method !== 'getContextGraph') throw new Error(`unexpected ${method}`);
      return TUPLE;
    });
    const peekContextGraphLiveAuthority = vi.fn(async () => options.peek);
    (adapter as any).contextGraphBoundedAuthorityReadsEnabled = options.enabled;
    (adapter as any).contextGraphAuthorityIndexReader = { peekContextGraphLiveAuthority };
    return { adapter, readContractWithOptions, peekContextGraphLiveAuthority };
  }

  it('answers a bounded read from the index without touching the chain', async () => {
    const { adapter, readContractWithOptions, peekContextGraphLiveAuthority } =
      boundedFixture({ enabled: true, peek: INDEX_ANSWER });

    await expect(adapter.getContextGraphLiveAuthority(7n, { freshness: 'bounded' }))
      .resolves.toEqual(INDEX_ANSWER);

    expect(peekContextGraphLiveAuthority).toHaveBeenCalledTimes(1);
    expect(readContractWithOptions).not.toHaveBeenCalled();
  });

  it('falls through to the chain when the index cannot answer', async () => {
    // `undefined` is "not folded yet", never "no such graph".
    const { adapter, readContractWithOptions } =
      boundedFixture({ enabled: true, peek: undefined });

    await expect(adapter.getContextGraphLiveAuthority(7n, { freshness: 'bounded' }))
      .resolves.toEqual(AUTHORITY);

    expect(readContractWithOptions).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the operator switch is off', { enabled: false, peek: INDEX_ANSWER }],
  ])('reads the chain when %s', async (_label, options) => {
    const { adapter, readContractWithOptions, peekContextGraphLiveAuthority } =
      boundedFixture(options as { enabled: boolean; peek: unknown });

    await expect(adapter.getContextGraphLiveAuthority(7n, { freshness: 'bounded' }))
      .resolves.toEqual(AUTHORITY);

    expect(peekContextGraphLiveAuthority).not.toHaveBeenCalled();
    expect(readContractWithOptions).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['freshness is omitted', undefined],
    ['freshness is explicitly live', { freshness: 'live' as const }],
  ])('reads the chain when %s', async (_label, options) => {
    const { adapter, readContractWithOptions, peekContextGraphLiveAuthority } =
      boundedFixture({ enabled: true, peek: INDEX_ANSWER });

    await expect(adapter.getContextGraphLiveAuthority(7n, options))
      .resolves.toEqual(AUTHORITY);

    // Live is the default and stays the default: an operator switch must never
    // silently downgrade a caller that did not ask for bounded freshness.
    expect(peekContextGraphLiveAuthority).not.toHaveBeenCalled();
    expect(readContractWithOptions).toHaveBeenCalledTimes(1);
  });

  it('never lets a live caller receive a bounded answer through the coalescer', async () => {
    // THE invariant. `flightKey` carries no freshness component, so if a
    // bounded answer were produced inside `run()` every caller sharing that key
    // would get it — including a gate that asked to be live precisely because
    // its decision cannot be taken back. The bounded path is therefore resolved
    // BEFORE the coalescer and never enters it.
    const { adapter, readContractWithOptions, peekContextGraphLiveAuthority } =
      boundedFixture({ enabled: true, peek: INDEX_ANSWER });

    const [bounded, live] = await Promise.all([
      adapter.getContextGraphLiveAuthority(7n, { freshness: 'bounded' }),
      adapter.getContextGraphLiveAuthority(7n, { freshness: 'live' }),
    ]);

    expect(bounded).toEqual(INDEX_ANSWER);
    expect(live).toEqual(AUTHORITY);
    expect(live).not.toEqual(bounded);
    expect(peekContextGraphLiveAuthority).toHaveBeenCalledTimes(1);
    expect(readContractWithOptions).toHaveBeenCalledTimes(1);
  });

  it('reads the chain when the node runs no authority index at all', async () => {
    const { adapter, readContractWithOptions } =
      boundedFixture({ enabled: true, peek: INDEX_ANSWER });
    (adapter as any).contextGraphAuthorityIndexReader = undefined;

    await expect(adapter.getContextGraphLiveAuthority(7n, { freshness: 'bounded' }))
      .resolves.toEqual(AUTHORITY);
    expect(readContractWithOptions).toHaveBeenCalledTimes(1);
  });
});
