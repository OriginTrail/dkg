import type { ConfirmedNamedKaVmPublication } from '../../src/named-ka-vm-lifecycle-recovery-error.js';
import type { ConfirmedNamedKaVmLifecycleInput } from '../../src/named-ka-vm-lifecycle-repair.js';

export function confirmedLifecycleRecoveryFixture(): { publication: ConfirmedNamedKaVmPublication; input: ConfirmedNamedKaVmLifecycleInput } {
  const root = new Uint8Array(32).fill(0x12), author = '0x' + '11'.repeat(20), ual = `did:dkg:mock:31337/${author}/1`;
  const input: ConfirmedNamedKaVmLifecycleInput = { contextGraphId: 'contract-cg', agentAddress: author, name: 'contract-ka',
    publishedUal: ual, merkleRoot: '0x' + '12'.repeat(32), assertionVersion: '1' };
  return { input, publication: { status: 'confirmed', kaId: 1n, ual, merkleRoot: root, kaManifest: [], assertionUri: 'urn:assertion:contract',
    seal: { merkleRoot: root, authorAddress: author, authorAttestationR: root, authorAttestationVS: root, authorSchemeVersion: 1,
      chainId: 31337n, kav10Address: '0x' + '22'.repeat(20), finalizedAtIso: '2026-01-01T00:00:00.000Z', contentScopeVersion: 2,
      kaUal: ual, assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0, rootEntities: [] },
    onChainResult: { batchId: 1n, txHash: '0x' + '34'.repeat(32), blockNumber: 12, txIndex: 3, blockTimestamp: 1767225600,
      publisherAddress: author, gasUsed: 22000n, effectiveGasPrice: 100n } } };
}
