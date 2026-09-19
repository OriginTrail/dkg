// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ContextGraphLiveAuthorityUnsupportedError } from '../src/chain-adapter.js';
import { fixture } from './context-graph-name-hash-reverse-resolution.fixtures.js';

const MEMBER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const NONEXISTENT = new ethers.Interface(['error ERC721NonexistentToken(uint256 tokenId)']);

function callException(overrides: Record<string, unknown>): Error {
  return Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', ...overrides });
}

describe('EVM adapter: one-read live context graph authority', () => {
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
    expect(label).toBe('cgStorage.getContextGraph');
    expect(method).toBe('getContextGraph');
    expect(args).toEqual([7n]);
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

  it('never reclassifies a CANCELLED read, even when its error looks classifiable', async () => {
    // Both shapes below are ones the classifiers would otherwise accept. With
    // the caller's signal already aborted they must come back as the transport
    // error: answering "unsupported" would send a cancelled call into the
    // three-read fallback, and answering `null` would be a terminal verdict
    // about a read that never completed.
    const looksUnsupported = fixture();
    const bare = Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null, reason: null });
    let releaseBare!: (reason: unknown) => void;
    looksUnsupported.readContractWithOptions.mockImplementation(
      () => new Promise((_resolve, reject) => { releaseBare = reject; }),
    );
    const cancelling = new AbortController();
    const first = looksUnsupported.adapter.getContextGraphLiveAuthority(7n, { signal: cancelling.signal });
    const firstSettled = first.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancelling.abort(new Error('caller stopped'));
    releaseBare(bare);
    await expect(firstSettled).resolves.not.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);

    const looksNonexistent = fixture();
    const revert = callException({ revert: { name: 'ERC721NonexistentToken', args: [7n] } });
    let releaseRevert!: (reason: unknown) => void;
    looksNonexistent.readContractWithOptions.mockImplementation(
      () => new Promise((_resolve, reject) => { releaseRevert = reject; }),
    );
    const cancellingToo = new AbortController();
    const second = looksNonexistent.adapter.getContextGraphLiveAuthority(7n, { signal: cancellingToo.signal });
    const secondSettled = second.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancellingToo.abort(new Error('caller stopped'));
    releaseRevert(revert);
    await expect(secondSettled).resolves.toBeInstanceOf(Error);
    await expect(secondSettled).resolves.not.toBeNull();

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
