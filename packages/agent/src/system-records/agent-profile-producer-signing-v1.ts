import {
  buildSystemRecordSignatureMessageV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  verifySignedSystemRecordEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { EvmPersonalMessageSignerV1 } from '../evm-message-signer-v1.js';
import type { SystemRecordPeerSignerV1 } from './agent-profile-producer-api-v1.js';
import type { AgentProfileProductionPreparationV1 } from './agent-profile-producer-preparation-v1.js';

interface AgentProfileProducerSigningContextV1 {
  readonly peerSigner: SystemRecordPeerSignerV1;
  readonly evmSigner: EvmPersonalMessageSignerV1;
}

export interface SignedAgentProfileProductionV1 {
  readonly envelope: SignedAgentProfileHeadEnvelopeV1;
  readonly envelopeBytes: Uint8Array;
}

type AgentProfileProducerSigningInputV1 = Pick<
  AgentProfileProductionPreparationV1,
  'head' | 'headDigest'
>;

export async function signAgentProfileProductionV1(
  dependencies: AgentProfileProducerSigningContextV1,
  preparation: AgentProfileProducerSigningInputV1,
  signal: AbortSignal,
): Promise<SignedAgentProfileProductionV1> {
  const [peerSignature, evmSignature] = await Promise.all([
    dependencies.peerSigner.sign(
      buildSystemRecordSignatureMessageV1(
        preparation.head,
        preparation.headDigest,
        'peer',
      ),
    ),
    dependencies.evmSigner.signMessage(
      buildSystemRecordSignatureMessageV1(
        preparation.head,
        preparation.headDigest,
        'current-evm',
      ),
    ),
  ]);
  signal.throwIfAborted();
  const envelope: SignedAgentProfileHeadEnvelopeV1 = {
    object: preparation.head,
    objectDigest: preparation.headDigest,
    signatures: Object.freeze([
      Object.freeze({
        role: 'peer',
        suite: 'ed25519-v1',
        signer: dependencies.peerSigner.peerId,
        evidence: Object.freeze({ kind: 'none' }),
        signature: Buffer.from(peerSignature).toString('base64url'),
      }),
      Object.freeze({
        role: 'current-evm',
        suite: 'eip191-personal-sign-digest-v1',
        signer: dependencies.evmSigner.address,
        evidence: Object.freeze({ kind: 'none' }),
        signature: evmSignature,
      }),
    ]),
  };
  if (!await verifySignedSystemRecordEnvelopeV1(envelope)) {
    throw new Error('new profile head signature verification failed');
  }
  return Object.freeze({
    envelope,
    envelopeBytes: canonicalizeSignedSystemRecordEnvelopeV1(envelope),
  });
}
