import { parseAssertionSealQuads } from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';
import { confirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-evidence.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

describe('confirmed lifecycle evidence ownership', () => {
  it('derives root, version, published UAL and deployment from the admitted publication', () => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    const coordinates = { contextGraphId: 'resolved-cg', name: 'resolved-name', agentAddress: 'resolved-agent',
      subGraphName: 'selected-subgraph', priorMerkleRoot: 'ab'.repeat(32), packedKaId: 9n };
    // The receipt root and a second overlapping description must never replace
    // the validated seal's lifecycle evidence or the resolved named coordinates.
    const derived = confirmedNamedKaVmLifecycleInput({ ...publication, merkleRoot: new Uint8Array(32).fill(0x99),
      seal: { ...publication.seal, assertionVersion: '2' } }, { ...input, ...coordinates, assertionVersion: '999', merkleRoot: '00' } as typeof coordinates);
    const { namedSealQuads, ...descriptor } = derived;
    expect(parseAssertionSealQuads([...namedSealQuads!], namedSealQuads![0]!.subject)).toMatchObject({
      assertionVersion: '2', merkleRoot: publication.seal.merkleRoot, authorAttestationR: publication.seal.authorAttestationR,
    });
    expect(descriptor).toEqual({ ...coordinates, publishedUal: publication.ual, merkleRoot: input.merkleRoot,
      assertionVersion: '2', publicationDeployment: { chainId: '31337', lifecycleAddress: publication.seal.kav10Address } });
    expect(Object.isFrozen(derived)).toBe(true); expect(Object.isFrozen(derived.publicationDeployment)).toBe(true);
  });
  it('keeps the caller-resolved identity when seal and receipt identities differ', () => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    const derived = confirmedNamedKaVmLifecycleInput({ ...publication,
      seal: { ...publication.seal, reservedKaId: 11n },
      onChainResult: { ...publication.onChainResult!, kaId: 3n } }, { ...input, packedKaId: 7n });
    expect(derived.packedKaId).toBe(7n);
  });
  it.each(['kaUal', 'assertionVersion'] as const)('refuses a missing validated seal %s before repair admission', field => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    expect(() => confirmedNamedKaVmLifecycleInput({ ...publication, seal: { ...publication.seal, [field]: undefined } }, input))
      .toThrow(expect.objectContaining({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' }));
  });
});
