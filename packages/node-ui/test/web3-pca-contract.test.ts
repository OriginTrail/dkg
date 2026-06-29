import { describe, expect, it } from 'vitest';
import { pad, type Address, type Hex } from 'viem';

import { extractAccountId } from '../src/ui/web3/pcaContract.js';

const NFT = `0x${'11'.repeat(20)}` as Address;
const TOKEN = `0x${'22'.repeat(20)}` as Address;
const OWNER = `0x${'33'.repeat(20)}` as Address;
const OTHER = `0x${'44'.repeat(20)}` as Address;

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

function addrTopic(a: Address): Hex {
  return pad(a.toLowerCase() as Hex, { size: 32 });
}
function idTopic(n: bigint): Hex {
  return pad(`0x${n.toString(16)}` as Hex, { size: 32 });
}

// The ERC-20 TRAC transferFrom log co-emitted by createAccount: TOKEN address, 3 topics (value NOT
// indexed → it sits in data), NOT a mint-from-zero.
function erc20TransferLog(): { address: Address; topics: Hex[]; data: Hex } {
  return {
    address: TOKEN,
    topics: [TRANSFER, addrTopic(OWNER), addrTopic(NFT)],
    data: idTopic(1000n),
  };
}
// The ERC-721 mint log: NFT address, 4 topics (tokenId IS indexed), from the zero address.
function erc721MintLog(to: Address, tokenId: bigint): { address: Address; topics: Hex[]; data: Hex } {
  return { address: NFT, topics: [TRANSFER, ZERO32, addrTopic(to), idTopic(tokenId)], data: '0x' };
}

describe('extractAccountId', () => {
  it('returns the tokenId from the NFT mint Transfer, ignoring the co-emitted TRAC transfer', () => {
    const receipt = { logs: [erc20TransferLog(), erc721MintLog(OWNER, 42n)] } as any;
    expect(extractAccountId(receipt, NFT, OWNER)).toBe(42n);
  });

  it('matches the mint regardless of log order', () => {
    const receipt = { logs: [erc721MintLog(OWNER, 7n), erc20TransferLog()] } as any;
    expect(extractAccountId(receipt, NFT, OWNER)).toBe(7n);
  });

  it('does not require the owner filter when omitted', () => {
    const receipt = { logs: [erc721MintLog(OWNER, 5n)] } as any;
    expect(extractAccountId(receipt, NFT)).toBe(5n);
  });

  it('throws when the only Transfer is the ERC-20 TRAC transfer (no mint → reconcile, no false id)', () => {
    const receipt = { logs: [erc20TransferLog()] } as any;
    expect(() => extractAccountId(receipt, NFT, OWNER)).toThrow();
  });

  it('throws when the mint is to a different owner (not this wallet)', () => {
    const receipt = { logs: [erc721MintLog(OTHER, 9n)] } as any;
    expect(() => extractAccountId(receipt, NFT, OWNER)).toThrow();
  });

  it('throws on a garbage / empty receipt', () => {
    expect(() => extractAccountId({ logs: [] } as any, NFT, OWNER)).toThrow();
  });
});
