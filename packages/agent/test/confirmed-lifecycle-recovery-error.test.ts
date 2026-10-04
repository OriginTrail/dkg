import { describe, expect, it } from 'vitest';
import { ConfirmedNamedKaVmLifecycleRecoveryError, isConfirmedNamedKaVmLifecycleRecoveryError } from '../src/named-ka-vm-lifecycle-recovery-error.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

function failure() {
  const { publication, input } = confirmedLifecycleRecoveryFixture();
  return new ConfirmedNamedKaVmLifecycleRecoveryError(publication, input, new Error('journal fsync failed'));
}
describe('confirmed lifecycle recovery package contract', () => {
  it('preserves the complete confirmed publication and immutable required recovery instructions with the original cause', () => {
    const { publication, input } = confirmedLifecycleRecoveryFixture(), cause = new Error('journal fsync failed');
    const error = new ConfirmedNamedKaVmLifecycleRecoveryError(publication, input, cause);
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(error)).toBe(true);
    expect(error.confirmedPublication).toBe(publication); expect(error.cause).toBe(cause);
    expect(error.lifecycleRecovery).toEqual({ ...input, action: 'recover_confirmed_publication', publicationRetrySafe: false });
    expect(Object.isFrozen(error.lifecycleRecovery)).toBe(true);
    expect(error).toMatchObject({ name: 'ConfirmedNamedKaVmLifecycleRecoveryError', publishedUal: input.publishedUal,
      merkleRoot: input.merkleRoot, assertionVersion: input.assertionVersion });
  });
  it.each(['pending', 'rejected'] as const)('preserves admitted %s completion without mislabeling journal loss', outcome => {
    const { publication, input } = confirmedLifecycleRecoveryFixture();
    const error = new ConfirmedNamedKaVmLifecycleRecoveryError(publication, input, new Error('unfinished'), outcome);
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(error)).toBe(true);
    expect(error.repairAdmission).toBe(outcome);
    expect(error.confirmedPublication).toBe(publication);
  });
  it.each([null, undefined, {}, new Error('other')])('refuses non-contract errors %j', error => {
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(error)).toBe(false);
  });
  it.each([
    ['invalid admission', { repairAdmission: 'submitted_again' }],
    ['publication missing', { confirmedPublication: undefined }],
    ['recovery missing', { lifecycleRecovery: null }],
    ['publication tentative', { confirmedPublication: { ...failure().confirmedPublication, status: 'tentative' } }],
    ['assertion absent', { confirmedPublication: { ...failure().confirmedPublication, assertionUri: undefined } }],
    ['root absent', { confirmedPublication: { ...failure().confirmedPublication, merkleRoot: undefined } }],
    ['seal absent', { confirmedPublication: { ...failure().confirmedPublication, seal: null } }],
    ['wrong recovery action', { lifecycleRecovery: { ...failure().lifecycleRecovery, action: 'publish_again' } }],
    ['unsafe retry', { lifecycleRecovery: { ...failure().lifecycleRecovery, publicationRetrySafe: true } }],
    ['context absent', { lifecycleRecovery: { ...failure().lifecycleRecovery, contextGraphId: undefined } }],
    ['coordinate mismatch', { lifecycleRecovery: { ...failure().lifecycleRecovery, publishedUal: 'did:dkg:mock/other' } }],
    ['tentative recovery', { lifecycleRecovery: { ...failure().lifecycleRecovery, tentative: true } }],
  ])('refuses malformed recovery evidence: %s', (_label, fields) => {
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(Object.assign(failure(), fields))).toBe(false);
  });
});


describe('structural recovery boundary evidence', () => {
  function foreignError(publicationChanges: Record<string, unknown> = {}) {
    const source = failure();
    return Object.assign(new Error('another package copy'), { code: source.code, repairAdmission: source.repairAdmission,
      confirmedPublication: { ...source.confirmedPublication, ...publicationChanges }, lifecycleRecovery: source.lifecycleRecovery });
  }
  it('recognizes a valid foreign producer without claiming its concrete class aliases', () => {
    const error = foreignError();
    expect(error).not.toBeInstanceOf(ConfirmedNamedKaVmLifecycleRecoveryError);
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(error)).toBe(true);
    expect('publishedUal' in error).toBe(false);
  });
  it.each([
    ['KA identity', { kaId: '1' }], ['author seal', { seal: {} }],
    ['transaction receipt', { onChainResult: { txHash: 1, blockNumber: 12 } }],
    ['receipt block', { onChainResult: { txHash: '0x1234', blockNumber: '12' } }],
    ['ACK container', { v10ACKs: {} }], ['ACK peer', { v10ACKs: [{ peerId: 3 }] }],
    ['pending flag', { lifecycleRepairPending: 'pending' }], ['graph error', { contextGraphError: 3 }],
    ['legacy author', { authorAddress: 3 }], ['legacy assets', { kas: {} }],
  ])('refuses malformed exposed %s fields', (_name, changes) => {
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(foreignError(changes))).toBe(false);
  });
  it('refuses inaccessible structural fields without throwing from the guard', () => {
    const error = foreignError();
    Object.defineProperty(error.confirmedPublication, 'seal', { get() { throw new Error('hostile getter'); } });
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(error)).toBe(false);
  });
});
