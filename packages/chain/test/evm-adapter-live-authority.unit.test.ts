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
      return { active: true, accessPolicy: 1n, participantAgents: [MEMBER.toUpperCase().replace('0X', '0x')] };
    });

    await expect(adapter.getContextGraphLiveAuthority(7n)).resolves.toEqual({
      active: true,
      accessPolicy: 1,
      participantAgents: [ethers.getAddress(MEMBER)],
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
      participantAgents: [ethers.getAddress(MEMBER), ethers.getAddress(OTHER)],
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

  it('propagates transient failures and a caller abort unchanged', async () => {
    const transient = fixture();
    transient.readContractWithOptions.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'SERVER_ERROR' }),
    );
    await expect(transient.adapter.getContextGraphLiveAuthority(7n)).rejects.toThrow('socket hang up');

    const aborted = fixture();
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    aborted.readContractWithOptions.mockRejectedValue(new Error('caller stopped'));
    await expect(aborted.adapter.getContextGraphLiveAuthority(7n, { signal: controller.signal }))
      .rejects.toThrow('caller stopped');
  });
});
