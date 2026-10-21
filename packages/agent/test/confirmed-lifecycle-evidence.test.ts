import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';
import { hexlify } from 'ethers';
import { describe, expect, it } from 'vitest';
import { confirmedNamedKaVmLifecycleInput, normalizeLifecycleRepairInput, reconcileLifecycleRepairEvidence } from '../src/named-ka-vm-lifecycle-evidence.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

describe('confirmed lifecycle evidence ownership', () => {
  it('derives root, version, published UAL and deployment from the admitted publication', () => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    const coordinates = { contextGraphId: 'resolved-cg', name: 'resolved-name', agentAddress: 'resolved-agent',
      subGraphName: 'selected-subgraph', priorMerkleRoot: 'ab'.repeat(32), packedKaId: input.packedKaId };
    // The receipt root and a second overlapping description must never replace
    // the validated seal's lifecycle evidence or the resolved named coordinates.
    const derived = confirmedNamedKaVmLifecycleInput({ ...publication, merkleRoot: new Uint8Array(32).fill(0x99),
      seal: { ...publication.seal, assertionVersion: '2' } }, { ...input, ...coordinates, assertionVersion: '999', merkleRoot: '00' } as typeof coordinates);
    const { namedSeal, ...descriptor } = derived;
    expect(namedSeal).toMatchObject({
      assertionVersion: '2', assertionMerkleRoot: hexlify(publication.seal.merkleRoot), authorAttestationR: hexlify(publication.seal.authorAttestationR),
    });
    expect(descriptor).toEqual({ ...coordinates, publishedUal: publication.ual, merkleRoot: input.merkleRoot,
      assertionVersion: '2', publicationDeployment: { chainId: '31337', lifecycleAddress: publication.seal.kav10Address } });
    expect(Object.isFrozen(derived)).toBe(true); expect(Object.isFrozen(derived.publicationDeployment)).toBe(true);
  });
  it('keeps the caller-resolved identity when the receipt identity differs', () => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    const derived = confirmedNamedKaVmLifecycleInput({ ...publication,
      onChainResult: { ...publication.onChainResult!, kaId: 3n } }, input);
    expect(derived.packedKaId).toBe(input.packedKaId);
  });
  it.each(['kaUal', 'assertionVersion'] as const)('refuses a missing validated seal %s before repair admission', field => {
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    expect(() => confirmedNamedKaVmLifecycleInput({ ...publication, seal: { ...publication.seal, [field]: undefined } }, input))
      .toThrow(expect.objectContaining({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' }));
  });
});

it('preserves unchanged evidence object identity and upgrades only missing seal evidence', () => {
  const input = confirmedMaterializationFixture().input;
  const complete = normalizeLifecycleRepairInput(input);
  expect(reconcileLifecycleRepairEvidence({ input: complete }, normalizeLifecycleRepairInput(input))).toEqual({ status: 'unchanged', input: complete });
  const unchanged = reconcileLifecycleRepairEvidence({ input: complete }, normalizeLifecycleRepairInput(input));
  if (unchanged.status === 'superseded') throw new Error('Expected retained evidence');
  expect(unchanged.input).toBe(complete);
  const { namedSeal: _seal, ...withoutSeal } = input;
  const retained = normalizeLifecycleRepairInput(withoutSeal), merged = reconcileLifecycleRepairEvidence({ input: retained }, complete);
  expect(merged.status).toBe('upgraded');
  if (merged.status === 'superseded') throw new Error('Expected upgrade');
  expect(merged.input.materialization).toBe(retained.materialization);
  expect(merged.input.namedSeal).toBe(complete.namedSeal);
  expect(Object.isFrozen(merged.input)).toBe(true);
});
it('fences older evidence and rejects a different lifecycle domain', () => {
  const first = normalizeLifecycleRepairInput(confirmedMaterializationFixture().input);
  const second = normalizeLifecycleRepairInput(confirmedMaterializationFixture(false, undefined, '2').input);
  expect(reconcileLifecycleRepairEvidence({ input: second }, first)).toEqual({ status: 'superseded' });
  const other = normalizeLifecycleRepairInput({ ...confirmedMaterializationFixture().input, name: 'different' });
  expect(() => reconcileLifecycleRepairEvidence({ input: first }, other)).toThrow('Conflicting confirmed evidence');
});
it('binds typed fresh evidence to the caller-resolved identity before execution', () => {
  const { input, publication } = confirmedLifecycleRecoveryFixture();
  const fields = confirmedNamedKaVmLifecycleInput({ ...publication, seal: { ...publication.seal, reservedKaId: input.packedKaId } }, { ...input, packedKaId: input.packedKaId + 1n });
  expect(fields.packedKaId).toBe(input.packedKaId + 1n);
  expect(() => normalizeLifecycleRepairInput(fields)).toThrow('Invalid confirmed');
});
