/**
 * Unit tests for evm-adapter pure helpers and constructor-only surface (07 EVM_MODULE —
 * revert decoding used across chain operations). No live RPC / Hardhat.
 */
import { describe, it, expect } from 'vitest';
import { Interface, ethers } from 'ethers';
import { decodeEvmError, enrichEvmError, EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b63b91100';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

describe('decodeEvmError / enrichEvmError (07 EVM_MODULE — custom errors)', () => {
  it('returns null for too-short hex', () => {
    expect(decodeEvmError('0x')).toBeNull();
    expect(decodeEvmError('0x1234')).toBeNull();
  });

  it('decodes BatchNotFound from merged Hub ABI errors', () => {
    const iface = new Interface(['error BatchNotFound(uint256 batchId)']);
    const data = iface.encodeErrorResult('BatchNotFound', [42n]);
    const d = decodeEvmError(data);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('BatchNotFound');
    expect(d!.args[0]).toBe(42n);
  });

  it('accepts Uint8Array input', () => {
    const iface = new Interface(['error BatchNotFound(uint256 batchId)']);
    const hex = iface.encodeErrorResult('BatchNotFound', [7n]);
    const bytes = ethers.getBytes(hex);
    const d = decodeEvmError(bytes);
    expect(d?.name).toBe('BatchNotFound');
  });

  it('enrichEvmError replaces unknown custom error substring when data is decodable', () => {
    const iface = new Interface(['error InvalidKARange(uint64 startKAId, uint64 endKAId)']);
    const data = iface.encodeErrorResult('InvalidKARange', [1n, 2n]);
    const err = new Error(
      `execution reverted (unknown custom error data="${data}")`,
    );
    const name = enrichEvmError(err);
    expect(name).toBe('InvalidKARange');
    expect(err.message).not.toContain('unknown custom error');
    expect(err.message).toContain('InvalidKARange');
  });

  it('enrichEvmError returns null when message has no data=', () => {
    expect(enrichEvmError(new Error('rpc failed'))).toBeNull();
  });
});

describe('EVMChainAdapter constructor / getters (no init)', () => {
  it('sets chainType, chainId default, and signer pool', () => {
    const a = new EVMChainAdapter(minimalConfig({ chainId: 'evm:84532' }));
    expect(a.chainType).toBe('evm');
    expect(a.chainId).toBe('evm:84532');
    expect(a.getSignerAddress()).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(a.getSignerAddresses()).toHaveLength(1);
    expect(a.getSignerAddresses()[0]).toBe(a.getSignerAddress());
  });

  it('includes additionalKeys in signer pool (round-robin for publish)', () => {
    const a = new EVMChainAdapter(minimalConfig({ additionalKeys: [OTHER_PK] }));
    const addrs = a.getSignerAddresses();
    expect(addrs).toHaveLength(2);
    expect(addrs[0]).not.toBe(addrs[1]);
  });

  it('getProvider returns JsonRpcProvider', () => {
    const a = new EVMChainAdapter(minimalConfig());
    expect(a.getProvider()).toBeDefined();
    expect(typeof a.getProvider().getBlockNumber).toBe('function');
  });

  it('signMessage returns 32-byte r and vs (no contract init)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const digest = ethers.randomBytes(32);
    const sig = await a.signMessage(digest);
    expect(sig.r).toHaveLength(32);
    expect(sig.vs).toHaveLength(32);
  });
});
