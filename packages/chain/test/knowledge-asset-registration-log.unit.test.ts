// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { decodeKnowledgeAssetRegistration } from '../src/knowledge-asset-registration-log.js';

const CG_STORAGE = '0x' + '5c'.repeat(20);
const OTHER = '0x' + '77'.repeat(20);
const KA_ID = (BigInt('0x' + '68'.repeat(20)) << 96n) | 150n;

const storage = { target: ethers.getAddress(CG_STORAGE), interface: new ethers.Interface(loadAbi('ContextGraphStorage')) };

function registrationLog(contextGraphId: bigint, kaId: bigint, address = CG_STORAGE) {
  const encoded = storage.interface.encodeEventLog('KnowledgeAssetRegisteredToContextGraph', [contextGraphId, kaId]);
  return { address, topics: encoded.topics, data: encoded.data };
}

describe('decodeKnowledgeAssetRegistration', () => {
  it('reads the graph the receipt registered the minted KA to', () => {
    expect(decodeKnowledgeAssetRegistration(storage, [registrationLog(1217n, KA_ID)], KA_ID)).toBe(1217n);
  });

  it('matches the address without regard to case and skips unrelated logs', () => {
    const logs = [
      { address: OTHER, topics: [ethers.id('Transfer(address,address,uint256)')], data: '0x' },
      registrationLog(42n, KA_ID, CG_STORAGE.toUpperCase().replace('0X', '0x')),
    ];
    expect(decodeKnowledgeAssetRegistration(storage, logs, KA_ID)).toBe(42n);
  });

  it('ignores the event from any other contract', () => {
    expect(decodeKnowledgeAssetRegistration(storage, [registrationLog(42n, KA_ID, OTHER)], KA_ID)).toBeUndefined();
  });

  it('ignores a registration of another KA', () => {
    expect(decodeKnowledgeAssetRegistration(storage, [registrationLog(42n, KA_ID + 1n)], KA_ID)).toBeUndefined();
  });

  it('answers nothing without the contract, for a zero KA id, or for a zero graph id', () => {
    expect(decodeKnowledgeAssetRegistration(undefined, [registrationLog(42n, KA_ID)], KA_ID)).toBeUndefined();
    expect(decodeKnowledgeAssetRegistration(storage, [registrationLog(42n, 0n)], 0n)).toBeUndefined();
    expect(decodeKnowledgeAssetRegistration(storage, [registrationLog(0n, KA_ID)], KA_ID)).toBeUndefined();
  });
});
