import type { KnowledgeAssetUpdateIdentity } from '@origintrail-official/dkg-chain';
import type { VmRefreshTarget } from '../src/vm-refresh.js';
const base = { localCgId: '1', ual: 'ual', kaId: 1n, merkleRoot: '0x01' };
// @ts-expect-error Queue input must explicitly identify its event evidence.
const partial: VmRefreshTarget = { ...base, blockNumber: 50, logIndex: 7 };
// @ts-expect-error A log position without a block is invalid.
const logWithoutBlock: KnowledgeAssetUpdateIdentity = { eventKind: 'log', logIndex: 7 };
// @ts-expect-error Transaction evidence must identify the transaction.
const noTransaction: KnowledgeAssetUpdateIdentity = { eventKind: 'transaction', blockNumber: 50 };
// @ts-expect-error Legacy unpositioned evidence cannot carry a partial position.
const legacyLog: KnowledgeAssetUpdateIdentity = { eventKind: 'legacy-unpositioned', logIndex: 7 };
void [partial, logWithoutBlock, noTransaction, legacyLog];
