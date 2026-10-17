import type { PrivateAccessResponse } from '../src/private-access-request.js';

declare const response: PrivateAccessResponse;
if (response.granted) {
  const root: string = response.privateMerkleRoot;
  const matches: true = response.verification.matches;
  const kind: 'peer-root-self-check' = response.verification.kind;
  void [root, matches, kind];
} else {
  const matches: false = response.verification.matches;
  const kind: 'not-checked' = response.verification.kind;
  void [matches, kind];
  // @ts-expect-error Denied responses carry no Merkle root.
  void response.privateMerkleRoot;
}
// @ts-expect-error A granted response must include its peer-supplied root.
const missingRoot: PrivateAccessResponse = { granted: true, quads: [], storedInGraph: false,
  verification: { kind: 'peer-root-self-check', matches: true, chainAnchored: false } };
void missingRoot;

import { accessError, isAccessError, type AccessErrorCode } from '@origintrail-official/dkg-publisher';
// @ts-expect-error Failure producers must use a declared code.
accessError('ACCESS_TIMOUT', 'typo');
declare const unknownFailure: unknown;
if (isAccessError(unknownFailure)) {
  const knownCode: AccessErrorCode = unknownFailure.code;
  void knownCode;
}
// @ts-expect-error Consumers must map every shared failure, including deadlines.
const incompleteStatuses: Record<AccessErrorCode, number> = { ACCESS_UNAVAILABLE: 503 };
void incompleteStatuses;

import { AccessClient, RequestOwnedAccessClient } from '@origintrail-official/dkg-publisher';
import type { Ed25519Keypair } from '@origintrail-official/dkg-core';
declare const keypair: Ed25519Keypair;
declare const legacyTransport: ConstructorParameters<typeof AccessClient>[0];
// @ts-expect-error Request-owned clients require an owned transport explicitly.
new RequestOwnedAccessClient(legacyTransport, keypair, 'peer');
declare const legacyClient: AccessClient;
// @ts-expect-error Response controls cannot silently switch legacy delivery ownership.
legacyClient.requestAccess('publisher', 'ual', undefined, { maxQuads: 1 });
