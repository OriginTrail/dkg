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
  it.each([null, undefined, {}, new Error('other')])('refuses non-contract errors %j', error => {
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(error)).toBe(false);
  });
  it.each([
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
