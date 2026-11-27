import { readShareCompletionEvidence } from '../../src/share-completion-evidence.js';

export const SHARE_AUTHOR = '0x3333333333333333333333333333333333333333';
export function shareEvidence() {
  return readShareCompletionEvidence({ version: 1, contextGraphId: 'reconcile-cg', assertionName: 'asset',
    agentAddress: SHARE_AUTHOR, entities: 'all', shareOperationId: 'original-operation',
    seal: { assertionMerkleRoot: `0x${'aa'.repeat(32)}`, authorAddress: SHARE_AUTHOR,
      authorAttestationR: `0x${'11'.repeat(32)}`, authorAttestationVS: `0x${'22'.repeat(32)}`,
      authorSchemeVersion: '1', assertedAtChainId: '31337',
      assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
      reservedKaId: ((BigInt(SHARE_AUTHOR) << 96n) | 7n).toString(),
      assertionFinalizedAt: '2026-10-19T00:00:00.000Z', contentScopeVersion: '2',
      kaUal: `did:dkg:evm:31337/${SHARE_AUTHOR}/7`, assertionVersion: '2',
      publicTripleCount: '1', privateTripleCount: '0', privateMerkleRoot: null },
  });
}
