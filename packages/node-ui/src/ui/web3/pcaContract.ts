// Adapted from OriginTrail/staking-ui-v10 (Apache-2.0, © OriginTrail).
//
// Inline ABI fragment for DKGPublishingConvictionNFT + the mint-receipt accountId decode. Only the
// methods the browser touches are shipped (small-ABI style; the full ABI never reaches the client).
// ERC-20 approve/allowance use viem's `erc20Abi` directly (not redefined here).

import { type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';

/**
 * The PCA NFT methods the in-browser wallet signs or reads:
 *  - WRITES: createAccount / topUp / registerAgent / deregisterAgent. (`settle` is included for
 *    completeness but the browser NEVER signs it — settle is permissionless and always routes to the
 *    daemon hot wallet, §9.2.)
 *  - ERC721Enumerable PER-OWNER walk: balanceOf + tokenOfOwnerByIndex (discovers a connected wallet's
 *    PCAs; tokenId === accountId). `ownerOf` verifies a tracked id's owner.
 *  - getDiscountBps: optional create-time estimate.
 * `createAccount` pulls `committedTRAC` from the caller, so the owner must `approve` TRAC to THIS NFT
 * contract (not the logic contract) first.
 */
export const publishingConvictionNftAbi = [
  {
    type: 'function',
    name: 'createAccount',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'committedTRAC', type: 'uint96' },
      { name: 'primaryNode', type: 'uint72' },
    ],
    outputs: [{ name: 'accountId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'topUp',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'accountId', type: 'uint256' },
      { name: 'amount', type: 'uint96' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'registerAgent',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'accountId', type: 'uint256' },
      { name: 'agent', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'deregisterAgent',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'accountId', type: 'uint256' },
      { name: 'agent', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'accountId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getDiscountBps',
    stateMutability: 'view',
    inputs: [{ name: 'committedTRAC', type: 'uint96' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const satisfies Abi;

// keccak256("Transfer(address,address,uint256)") — shared by ERC-20 and ERC-721.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** Lowercased last-20-bytes of a 32-byte address topic. */
function addrFromTopic(topic: Hex): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * Decode the new PCA's accountId from a `createAccount` receipt — the ERC-721 mint `Transfer`'s
 * `tokenId` topic (tokenId === accountId). The create receipt co-emits TWO logs that share the
 * `Transfer` topic0: the ERC-20 TRAC `transferFrom` (on the TOKEN address, 3 topics — value is NOT
 * indexed) and the ERC-721 `_mint` (on the NFT address, 4 topics — tokenId IS indexed). We require,
 * in order: `log.address === nft` (drops the TRAC transfer) AND topic0 === Transfer AND exactly 4
 * topics (ERC-721 shape) AND `from === 0x0` (a mint) AND (when `owner` is given) `to === owner`.
 * Throws when no matching mint is present so the caller falls to reconcile (never a false id).
 */
export function extractAccountId(
  receipt: Pick<TransactionReceipt, 'logs'>,
  nft: Address,
  owner?: Address,
): bigint {
  const nftLc = nft.toLowerCase();
  const ownerLc = owner?.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== nftLc) continue;
    const topics = log.topics as Hex[];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topics.length !== 4) continue; // ERC-721 (tokenId indexed); the ERC-20 Transfer has 3
    if (topics[1]?.toLowerCase() !== ZERO_TOPIC) continue; // mint = from the zero address
    if (ownerLc && addrFromTopic(topics[2]!) !== ownerLc) continue;
    return BigInt(topics[3]!);
  }
  throw new Error('No PCA mint Transfer found in the create receipt');
}
