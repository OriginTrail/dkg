import type { AssertionPromoteOptions, PreSignedAuthorAttestation } from '../src/dkg-agent-types.js';
import type { PromoteRecoveryBinding } from '@origintrail-official/dkg-publisher';
declare const binding: PromoteRecoveryBinding;
declare const signed: PreSignedAuthorAttestation;
const ordinary: AssertionPromoteOptions = { entities: ['urn:root'], accessPolicy: 'public' };
const bound: AssertionPromoteOptions = { recoveryBinding: binding, entities: 'all', curatorAckTimeoutMs: 123 };
// @ts-expect-error Immutable replay cannot select a subset.
const subset: AssertionPromoteOptions = { recoveryBinding: binding, entities: ['urn:root'] };
// @ts-expect-error Immutable replay cannot bypass its seal.
const skip: AssertionPromoteOptions = { recoveryBinding: binding, skipSeal: true };
// @ts-expect-error The admitted intent is the sole policy source.
const policy: AssertionPromoteOptions = { recoveryBinding: binding, accessPolicy: 'public' };
// @ts-expect-error The admitted intent is the sole recipient source.
const peers: AssertionPromoteOptions = { recoveryBinding: binding, allowedPeers: [] };
// @ts-expect-error A bound share cannot introduce a new author attestation.
const attestation: AssertionPromoteOptions = { recoveryBinding: binding, preSignedAuthorAttestation: signed };
void [ordinary, bound, subset, skip, policy, peers, attestation];
