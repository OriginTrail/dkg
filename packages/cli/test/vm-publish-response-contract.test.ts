import { ConfirmedNamedKaVmLifecycleRecoveryError, isConfirmedNamedKaVmLifecycleRecoveryError } from '@origintrail-official/dkg-agent';
import { confirmedLifecycleRecoveryFixture } from '../../agent/test/_helpers/confirmed-lifecycle-recovery-fixture.js';
import { describe, expect, it } from 'vitest';
import { confirmedVmRecoveryRequiredResponse } from '../src/daemon/routes/vm-publish-response.js';

describe('confirmed recovery response contract', () => {
  it('consumes the exported guard and preserves the exact confirmed receipt and actionable typed recovery payload', () => {
    const { publication, input } = confirmedLifecycleRecoveryFixture();
    const error = new ConfirmedNamedKaVmLifecycleRecoveryError(publication, input, new Error('journal unavailable'));
    expect(isConfirmedNamedKaVmLifecycleRecoveryError(error)).toBe(true);
    const response = confirmedVmRecoveryRequiredResponse(error)!;
    expect(response).toMatchObject({ status: 'confirmed', ual: publication.ual, assertionUri: publication.assertionUri,
      merkleRoot: input.merkleRoot, txHash: publication.onChainResult!.txHash, lifecycleRecoveryRequired: true,
      lifecycleRepairAdmitted: false, lifecycleRepairPending: false, code: 'KA_VM_LIFECYCLE_REPAIR_REQUIRED' });
    expect(response.onChainResult).toBe(publication.onChainResult);
    expect(response.recovery).toBe(error.lifecycleRecovery);
  });
  it('does not claim actionable confirmed recovery from an error missing required recovery evidence', () => {
    const incomplete = Object.assign(new Error('incomplete recovery descriptor'), {
      code: 'KA_VM_LIFECYCLE_REPAIR_REQUIRED', confirmedPublication: { status: 'confirmed', ual: 'did:dkg:mock/1' },
    });
    expect(confirmedVmRecoveryRequiredResponse(incomplete)).toBeUndefined();
  });
});
