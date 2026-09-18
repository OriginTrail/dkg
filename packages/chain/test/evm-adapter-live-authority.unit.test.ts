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

  it('decodes the positional tuple shape ethers may hand back', async () => {
    const { adapter, readContractWithOptions } = fixture();
    // (owner, participantAgents, metadataBatchId, active, createdAt, accessPolicy, ...)
    readContractWithOptions.mockResolvedValue([OTHER, [MEMBER, OTHER], 0n, false, 0n, 0n, 1n, OTHER, 0n]);

    await expect(adapter.getContextGraphLiveAuthority(7n)).resolves.toEqual({
      active: false,
      accessPolicy: 0,
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

    // The same error for a DIFFERENT id is not proof about this one.
    const otherId = fixture();
    otherId.readContractWithOptions.mockRejectedValue(
      callException({ data: NONEXISTENT.encodeErrorResult('ERC721NonexistentToken', [8n]) }),
    );
    await expect(otherId.adapter.getContextGraphLiveAuthority(7n)).rejects.toThrow('execution reverted');
  });

  it('reports an absent selector as unsupported so callers fall back to the point reads', async () => {
    const bare = fixture();
    bare.readContractWithOptions.mockRejectedValue(
      Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null, reason: null }),
    );
    await expect(bare.adapter.getContextGraphLiveAuthority(7n))
      .rejects.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);

    const badData = fixture();
    badData.readContractWithOptions.mockRejectedValue(
      Object.assign(new Error('could not decode result data (value="0x", info=...)'), { code: 'BAD_DATA' }),
    );
    await expect(badData.adapter.getContextGraphLiveAuthority(7n))
      .rejects.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);
  });

  it('propagates a transient failure unchanged', async () => {
    const transient = fixture();
    transient.readContractWithOptions.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'SERVER_ERROR' }),
    );
    await expect(transient.adapter.getContextGraphLiveAuthority(7n)).rejects.toThrow('socket hang up');
  });

  it('never reclassifies a CANCELLED read, even when its error looks classifiable', async () => {
    // Both shapes below are ones the classifiers would otherwise accept. With
    // the caller's signal already aborted they must come back as the transport
    // error: answering "unsupported" would send a cancelled call into the
    // three-read fallback, and answering `null` would be a terminal verdict
    // about a read that never completed.
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));

    const looksUnsupported = fixture();
    const bare = Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null, reason: null });
    looksUnsupported.readContractWithOptions.mockRejectedValue(bare);
    const first = looksUnsupported.adapter.getContextGraphLiveAuthority(7n, { signal: controller.signal });
    await expect(first).rejects.toBe(bare);
    await expect(first).rejects.not.toBeInstanceOf(ContextGraphLiveAuthorityUnsupportedError);

    const looksNonexistent = fixture();
    const revert = callException({ revert: { name: 'ERC721NonexistentToken', args: [7n] } });
    looksNonexistent.readContractWithOptions.mockRejectedValue(revert);
    await expect(looksNonexistent.adapter.getContextGraphLiveAuthority(7n, { signal: controller.signal }))
      .rejects.toBe(revert);
  });

  it('is id-exact on the DECODED revert too: another token proves nothing about this one', async () => {
    const otherIdByName = fixture();
    otherIdByName.readContractWithOptions.mockRejectedValue(
      callException({ revert: { name: 'ERC721NonexistentToken', args: [8n] } }),
    );
    // Resolving null here would be TERMINAL: a live graph reported as gone forever.
    await expect(otherIdByName.adapter.getContextGraphLiveAuthority(7n)).rejects.toThrow('execution reverted');

    for (const args of [undefined, [], ['not-a-number']]) {
      const malformed = fixture();
      malformed.readContractWithOptions.mockRejectedValue(
        callException({ revert: { name: 'ERC721NonexistentToken', args } }),
      );
      await expect(malformed.adapter.getContextGraphLiveAuthority(7n)).rejects.toThrow('execution reverted');
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
