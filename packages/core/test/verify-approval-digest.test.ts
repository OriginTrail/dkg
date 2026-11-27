import { describe, expect, it } from 'vitest';
import {
  computeACKDigest,
  computePublishACKDigest,
  computeVerifyApprovalDigest,
} from '../src/index.js';

const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const bytes = (value: string) => Uint8Array.from(value.slice(2).match(/../g)!, (pair) => parseInt(pair, 16));

const CHAIN_ID = 84532n;
const CONTRACT = '0x00000000000000000000000000000000000000A1';
const CONTEXT_GRAPH_ID = 42n;
const BATCH_ID = 7n;
/** keccak256("verify-approval-root") */
const ROOT = bytes('0xe580d3a6d8a05e7ae744649db4b99a7d97e18f700bd225fc2995f91f8d678103');

describe('computeVerifyApprovalDigest', () => {
  it('is keccak256 over the packed tag, chain id, contract, context graph id, batch id and root', () => {
    // From ethers.solidityPackedKeccak256(['bytes32', 'uint256', 'address', 'uint256', 'uint256', 'bytes32'],
    //   [id('dkg:verify-approval:v1'), 84532, CONTRACT, 42, 7, ROOT]), computed outside this package.
    expect(hex(computeVerifyApprovalDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID, BATCH_ID, ROOT)))
      .toBe('0xfb2f3a7e6ea7275c218a6ad1d4ca73f78412df9c323fe2382cdfc9a424638e1f');
  });

  it('changes with each field it binds', () => {
    const base = hex(computeVerifyApprovalDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID, BATCH_ID, ROOT));
    const otherRoot = ROOT.slice();
    otherRoot[0] ^= 1;
    for (const digest of [
      computeVerifyApprovalDigest(CHAIN_ID + 1n, CONTRACT, CONTEXT_GRAPH_ID, BATCH_ID, ROOT),
      computeVerifyApprovalDigest(CHAIN_ID, '0x00000000000000000000000000000000000000a2', CONTEXT_GRAPH_ID, BATCH_ID, ROOT),
      computeVerifyApprovalDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID + 1n, BATCH_ID, ROOT),
      computeVerifyApprovalDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID, BATCH_ID + 1n, ROOT),
      computeVerifyApprovalDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID, BATCH_ID, otherRoot),
    ]) {
      expect(hex(digest)).not.toBe(base);
    }
  });

  it('differs from the ACK digests over the same context graph and root', () => {
    const digest = hex(computeVerifyApprovalDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID, BATCH_ID, ROOT));
    expect(digest).not.toBe(hex(computeACKDigest(CONTEXT_GRAPH_ID, ROOT)));
    expect(digest).not.toBe(hex(
      computePublishACKDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID, ROOT, 1n, 0n, 1n, 0n, 1n),
    ));
  });

  it('refuses a root that is not 32 bytes and a malformed contract address', () => {
    expect(() => computeVerifyApprovalDigest(CHAIN_ID, CONTRACT, CONTEXT_GRAPH_ID, BATCH_ID, ROOT.slice(1)))
      .toThrow('merkleRoot must be 32 bytes');
    expect(() => computeVerifyApprovalDigest(CHAIN_ID, '0x1234', CONTEXT_GRAPH_ID, BATCH_ID, ROOT))
      .toThrow(/20-byte hex/);
  });
});
