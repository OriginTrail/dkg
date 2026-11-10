// SPDX-License-Identifier: Apache-2.0
/**
 * ContextGraphs 10.1.0 author gate, chain side: the absent-view classifier,
 * the capability guard, `EVMChainAdapter.isAuthorizedAuthor` against a stubbed
 * facade, and decoding of the new revert from the vendored ABI.
 */
import { describe, expect, it } from 'vitest';
import { ethers, Interface } from 'ethers';
import { createRequire } from 'node:module';
import {
  AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_ERROR,
  hasContextGraphAuthorGate,
  isAbsentContractViewError,
} from '../src/context-graph-author-gate.js';
import { decodeEvmError, EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { connectable } from './connectable.js';

const require = createRequire(import.meta.url);
const contextGraphsAbi = require('../abi/ContextGraphs.json');

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AUTHOR = '0x8ba1f109551bd432803012645ac136ddd64dba72';

function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
}

/** What ethers v6 throws for a call to a selector the contract lacks (no fallback). */
function missingRevertData(): Error {
  return ethers.makeError('missing revert data', 'CALL_EXCEPTION', {
    action: 'call',
    data: null,
    reason: null,
    transaction: { to: '0x0000000000000000000000000000000000000002', data: '0x' },
    invocation: null,
    revert: null,
  });
}

function adapterWith(contextGraphs: unknown): EVMChainAdapter {
  const adapter = new EVMChainAdapter(minimalConfig());
  (adapter as any).init = async () => undefined;
  (adapter as any).contracts.contextGraphs = contextGraphs === undefined ? undefined : connectable(contextGraphs);
  return adapter;
}

describe('isAbsentContractViewError', () => {
  it('reads a revert without data, an empty result and a selector message as an absent view', () => {
    expect(isAbsentContractViewError(missingRevertData())).toBe(true);
    const emptyResult = ethers.makeError('could not decode result data', 'BAD_DATA', { value: '0x' });
    expect(isAbsentContractViewError(emptyResult)).toBe(true);
    expect(isAbsentContractViewError(new Error('execution reverted: function selector was not recognized'))).toBe(true);
  });

  it('never reads a revert that carries data or a reason, or a transport failure, as absent', () => {
    const withData = ethers.makeError('execution reverted', 'CALL_EXCEPTION', {
      action: 'call', data: '0xdeadbeef', reason: null, transaction: { data: '0x' }, invocation: null, revert: null,
    });
    const withReason = ethers.makeError('execution reverted: Paused', 'CALL_EXCEPTION', {
      action: 'call', data: null, reason: 'Paused', transaction: { data: '0x' }, invocation: null, revert: null,
    });
    const transport = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8545'), { code: 'ECONNREFUSED' });
    expect(isAbsentContractViewError(withData)).toBe(false);
    expect(isAbsentContractViewError(withReason)).toBe(false);
    expect(isAbsentContractViewError(transport)).toBe(false);
  });
});

describe('hasContextGraphAuthorGate', () => {
  it('accepts only an object with the view', () => {
    expect(hasContextGraphAuthorGate({ isAuthorizedAuthor: async () => true })).toBe(true);
    expect(hasContextGraphAuthorGate({})).toBe(false);
    expect(hasContextGraphAuthorGate(null)).toBe(false);
    expect(hasContextGraphAuthorGate(undefined)).toBe(false);
  });

  it('is implemented by the EVM adapter', () => {
    expect(hasContextGraphAuthorGate(new EVMChainAdapter(minimalConfig()))).toBe(true);
  });
});

describe('EVMChainAdapter.isAuthorizedAuthor', () => {
  it('returns the facade answer for the checksummed author', async () => {
    const calls: Array<[bigint, string]> = [];
    const adapter = adapterWith({
      isAuthorizedAuthor: async (cgId: bigint, author: string) => {
        calls.push([cgId, author]);
        return author === ethers.getAddress(AUTHOR) && cgId === 7n;
      },
    });
    await expect(adapter.isAuthorizedAuthor(7n, AUTHOR)).resolves.toBe(true);
    await expect(adapter.isAuthorizedAuthor(8n, AUTHOR)).resolves.toBe(false);
    expect(calls).toEqual([[7n, ethers.getAddress(AUTHOR)], [8n, ethers.getAddress(AUTHOR)]]);
  });

  it('resolves undefined, after one call, on a facade without the view (< 10.1.0)', async () => {
    let calls = 0;
    const adapter = adapterWith({
      isAuthorizedAuthor: async () => {
        calls += 1;
        throw missingRevertData();
      },
    });
    await expect(adapter.isAuthorizedAuthor(7n, AUTHOR)).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('resolves undefined without a ContextGraphs binding', async () => {
    await expect(adapterWith(undefined).isAuthorizedAuthor(7n, AUTHOR)).resolves.toBeUndefined();
  });

  it('rejects when the read fails for any other reason', async () => {
    const adapter = adapterWith({
      isAuthorizedAuthor: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:59998'), { code: 'ECONNREFUSED' });
      },
    });
    await expect(adapter.isAuthorizedAuthor(7n, AUTHOR)).rejects.toThrow();
  });
});

describe('AuthorNotContextGraphMember revert', () => {
  it('decodes from the vendored ContextGraphs ABI', () => {
    const data = new Interface(contextGraphsAbi).encodeErrorResult(AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_ERROR, [
      7n,
      ethers.getAddress(AUTHOR),
    ]);
    const decoded = decodeEvmError(data);
    expect(decoded?.name).toBe(AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_ERROR);
    expect(decoded?.args[0]).toBe(7n);
    expect(decoded?.args[1]).toBe(ethers.getAddress(AUTHOR));
  });
});
