import type { PrivateAccessResponse } from '../src/private-access-request.js';
import type { requestOwnedPrivateAccess } from '../src/private-access-request.js';

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

import { AccessClient, RequestOwnedAccessClient, type AccessResult, type RequestOwnedAccessResult } from '@origintrail-official/dkg-publisher';
import type { Ed25519Keypair } from '@origintrail-official/dkg-core';
declare const keypair: Ed25519Keypair;
declare const legacyTransport: ConstructorParameters<typeof AccessClient>[0];
// @ts-expect-error Request-owned clients require an owned transport explicitly.
new RequestOwnedAccessClient(legacyTransport, keypair, 'peer');
declare const legacyClient: AccessClient;
// @ts-expect-error Response controls cannot silently switch legacy delivery ownership.
legacyClient.requestAccess('publisher', 'ual', undefined, { maxQuads: 1 });

import type { RequestOwnedAccessSendSurface } from '@origintrail-official/dkg-publisher';
import type { Messenger } from '../src/p2p/messenger.js';
declare const messenger: Messenger;
const ownedTransport: RequestOwnedAccessSendSurface = {
  sendRequestOwned: messenger.sendRequestOwned.bind(messenger),
};
const durableTransport: RequestOwnedAccessSendSurface = {
  // @ts-expect-error Durable failures may be queued; owned failures must have queued:false.
  sendRequestOwned: messenger.sendReliable.bind(messenger),
};
void [ownedTransport, durableTransport];
const minimalOwner: Parameters<typeof requestOwnedPrivateAccess>[0] = {
  messenger: ownedTransport, wallet: { keypair }, peerId: 'peer', node: { stopSignal: new AbortController().signal },
};
void minimalOwner;

type OwnedAccessResult = Awaited<ReturnType<RequestOwnedAccessClient['requestAccess']>>;
declare const ownedResult: OwnedAccessResult;
if (ownedResult.granted) {
  const root: Uint8Array = ownedResult.privateMerkleRoot;
  const verified: boolean = ownedResult.verified;
  void [root, verified];
} else {
  const verified: false = ownedResult.verified;
  const noQuads: [] = ownedResult.quads;
  // @ts-expect-error Denied decoded responses do not expose a root.
  void ownedResult.privateMerkleRoot;
  void [verified, noQuads];
}
// @ts-expect-error Every granted owned response carries the decoded root, including unverified payloads.
const ownedMissingRoot: OwnedAccessResult = { granted: true, quads: [], verified: false };
// @ts-expect-error A denied owned response cannot contain content root evidence.
const ownedDeniedWithRoot: OwnedAccessResult = { granted: false, quads: [], verified: false, privateMerkleRoot: new Uint8Array() };
const ownedUnverified: OwnedAccessResult = { granted: true, quads: [], verified: false, privateMerkleRoot: new Uint8Array() };
// Existing SDK consumers keep the legacy, wider contract; owned results remain assignable to it.
const legacyResult: AccessResult = { granted: true, quads: [], verified: false };
const compatibleResult: AccessResult = ownedResult;
const publicOwnedResult: RequestOwnedAccessResult = ownedResult;
void [ownedMissingRoot, ownedDeniedWithRoot, ownedUnverified, legacyResult, compatibleResult, publicOwnedResult];
