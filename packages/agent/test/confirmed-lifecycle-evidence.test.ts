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
    expect(derived).toEqual({ ...coordinates, publishedUal: publication.ual, merkleRoot: input.merkleRoot,
      assertionVersion: '2', publicationDeployment: { chainId: '31337', lifecycleAddress: publication.seal.kav10Address } });
    expect(Object.isFrozen(derived)).toBe(true); expect(Object.isFrozen(derived.publicationDeployment)).toBe(true);
  });
  it.each([
    ['resolved identity', 7n, 3n, 7n],
    ['chain receipt', undefined, 3n, 3n],
    ['publication result', undefined, undefined, 1n],
  ] as const)('preserves the %s packed-ID selection', (_label, override, receipt, expected) => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    const derived = confirmedNamedKaVmLifecycleInput({ ...publication, seal: { ...publication.seal, reservedKaId: 11n },
      onChainResult: { ...publication.onChainResult!, kaId: receipt } }, { contextGraphId: input.contextGraphId,
      name: input.name, agentAddress: input.agentAddress, ...(override === undefined ? {} : { packedKaId: override }) });
    expect(derived.packedKaId).toBe(expected);
  });
  it('uses a queued seal reservation only when selected as the already resolved identity', () => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    const reserved = { ...publication, seal: { ...publication.seal, reservedKaId: 11n } };
    const coordinates = { contextGraphId: input.contextGraphId, agentAddress: input.agentAddress, name: input.name };
    expect(confirmedNamedKaVmLifecycleInput(reserved, coordinates).packedKaId).toBe(publication.kaId);
    expect(confirmedNamedKaVmLifecycleInput(reserved, { ...coordinates, packedKaId: reserved.seal.reservedKaId }).packedKaId).toBe(11n);
  });
  it.each(['kaUal', 'assertionVersion'] as const)('refuses a missing validated seal %s before repair admission', field => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    expect(() => confirmedNamedKaVmLifecycleInput({ ...publication, seal: { ...publication.seal, [field]: undefined } }, input))
      .toThrow(expect.objectContaining({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' }));
  });
});
