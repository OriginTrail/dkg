import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  KA_ID_ALREADY_MINTED_SELECTOR,
  kaIdAlreadyMintedFromError,
  kaIdAlreadyMintedRevert,
} from '../src/ka-id-already-minted.js';
import { decodeEvmError } from '../src/evm-adapter-errors.js';
import { decodeKnowledgeAssetMintReceipt } from '../src/knowledge-asset-mint-evidence.js';
import { loadAbi } from '../src/evm-adapter-abi.js';

const KA_ID = (BigInt('0x' + 'ab'.repeat(20)) << 96n) | 7n;
const revertData = (kaId: bigint) => kaIdAlreadyMintedRevert(kaId).data as string;

describe('kaIdAlreadyMintedFromError', () => {
  it('matches the vendored DKGKnowledgeAssets error', () => {
    const decoded = decodeEvmError(revertData(KA_ID));
    expect(decoded?.name).toBe('KaIdAlreadyMinted');
    expect(decoded?.selector).toBe(KA_ID_ALREADY_MINTED_SELECTOR);
    expect(BigInt(decoded!.args[0])).toBe(KA_ID);
  });

  it('reads revert data where ethers and JSON-RPC providers put it', () => {
    const data = revertData(KA_ID);
    expect(kaIdAlreadyMintedFromError({ code: 'CALL_EXCEPTION', data })).toBe(KA_ID);
    expect(kaIdAlreadyMintedFromError({ info: { error: { code: 3, data } } })).toBe(KA_ID);
    expect(kaIdAlreadyMintedFromError(new Error('wrapped', { cause: { errorData: data } }))).toBe(KA_ID);
    expect(kaIdAlreadyMintedFromError({ data: ethers.getBytes(data) })).toBe(KA_ID);
  });

  it('never decodes message text, calldata, other errors or conflicting ids', () => {
    const data = revertData(KA_ID);
    expect(kaIdAlreadyMintedFromError(new Error(`execution reverted (data="${data}")`))).toBeNull();
    expect(kaIdAlreadyMintedFromError({ transaction: { data } })).toBeNull();
    expect(kaIdAlreadyMintedFromError({ data: `${data}00` })).toBeNull();
    expect(kaIdAlreadyMintedFromError({ data: `0xdeadbeef${data.slice(10)}` })).toBeNull();
    expect(kaIdAlreadyMintedFromError({ data, info: { error: { data: revertData(KA_ID + 1n) } } })).toBeNull();
    expect(kaIdAlreadyMintedFromError(null)).toBeNull();
  });
});

describe('decodeKnowledgeAssetMintReceipt', () => {
  const knowledgeAssets = { address: ethers.getAddress('0x' + '11'.repeat(20)), interface: new ethers.Interface(loadAbi('DKGKnowledgeAssets')) };
  const contextGraphStorage = { address: ethers.getAddress('0x' + '22'.repeat(20)), interface: new ethers.Interface(loadAbi('ContextGraphStorage')) };
  const root = ethers.keccak256(ethers.toUtf8Bytes('root'));
  const author = ethers.getAddress('0x' + 'ab'.repeat(20));
  const created = (kaId: bigint, address = knowledgeAssets.address) => ({
    address,
    ...knowledgeAssets.interface.encodeEventLog('KnowledgeAssetCreated', [kaId, author, 'op', root, 256n, 1n, 3n, 42n, false]),
  });
  const registered = (contextGraphId: bigint, kaId: bigint) => ({
    address: contextGraphStorage.address,
    ...contextGraphStorage.interface.encodeEventLog('KnowledgeAssetRegisteredToContextGraph', [contextGraphId, kaId]),
  });
  const contracts = { knowledgeAssets, contextGraphStorage };

  it('takes id, root, author, cost and context graph from the one receipt', () => {
    // A log of the same contract that does not decode as a known event is skipped.
    const undecodable = { ...created(KA_ID), data: '0x' };
    expect(decodeKnowledgeAssetMintReceipt([undecodable, created(KA_ID), registered(35n, KA_ID)], contracts, KA_ID)).toEqual({
      kaId: KA_ID,
      merkleRoot: ethers.getBytes(root),
      contextGraphId: 35n,
      authorAddress: author,
      tokenAmount: 42n,
      knowledgeAssetsContract: knowledgeAssets.address,
    });
  });

  it('rejects a receipt that does not carry exactly one creation and one registration for the id', () => {
    const other = KA_ID + 1n;
    for (const logs of [
      [registered(35n, KA_ID)],
      [created(other), registered(35n, KA_ID)],
      [created(KA_ID, contextGraphStorage.address), registered(35n, KA_ID)],
      [created(KA_ID)],
      [created(KA_ID), registered(35n, other)],
      [created(KA_ID), registered(35n, KA_ID), registered(36n, KA_ID)],
    ]) {
      expect(typeof decodeKnowledgeAssetMintReceipt(logs, contracts, KA_ID)).toBe('string');
    }
  });
});
