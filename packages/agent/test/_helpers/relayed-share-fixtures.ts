// SPDX-License-Identifier: Apache-2.0

/**
 * Shares as a member's node sends them into a named sub-graph of a public
 * graph: the request with the author seal its finalize wrote, in the gossip
 * envelope the author signs. For the tests of a Core passing a member's share
 * on to the graph's owner.
 */
import { ethers } from 'ethers';
import {
  AUTHOR_SCHEME_VERSION_V1,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  buildAuthorAttestationTypedData,
  computeGossipSigningPayload,
  contextGraphDataUri,
  encodeEncryptedWorkspacePayload,
  encodeGossipEnvelope,
  encodeSwmSenderKeyMessage,
  encodeWorkspacePublishRequest,
  type AssertionSeal,
  type WorkspacePublishRequestMsg,
} from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { sharedMemoryAuthorSealFields } from '../../../publisher/src/shared-memory-author-seal.js';

export const OWNER_WALLET = new ethers.Wallet(`0x${'31'.repeat(32)}`);
export const AUTHOR = new ethers.Wallet(`0x${'32'.repeat(32)}`);
export const SECOND_AUTHOR = new ethers.Wallet(`0x${'33'.repeat(32)}`);
export const STRANGER = new ethers.Wallet(`0x${'34'.repeat(32)}`);
/** A public graph whose id names its owner's wallet. */
export const RELAYED_CG = `${OWNER_WALLET.address.toLowerCase()}/relayed-share`;
export const REPORTS = 'reports';
export const SUBJECT_PREDICATE = 'http://schema.org/name';
const KAV10 = ethers.getAddress(`0x${'12'.repeat(20)}`);

export interface RelayedShareOptions {
  readonly author?: ethers.Wallet;
  /** Signs the envelope; the author by default. */
  readonly signer?: ethers.Wallet;
  readonly value?: string;
  readonly assertionName?: string;
  readonly publisherPeerId?: string;
  readonly shareOperationId?: string;
  readonly kaNumber?: bigint;
  readonly contextGraphId?: string;
  /** The envelope's signing time; now by default. */
  readonly signedAt?: Date;
  readonly request?: Partial<WorkspacePublishRequestMsg>;
}

export function subjectOf(value: string): string {
  return `urn:test:relayed-share:${encodeURIComponent(value)}`;
}

function ualOf(author: ethers.Wallet, kaNumber: bigint): string {
  return `did:dkg:evm:31337/${author.address.toLowerCase()}/${kaNumber}`;
}

/** The seal the author's finalize writes for one triple holding `value`. */
async function sealOf(author: ethers.Wallet, value: string, kaNumber: bigint): Promise<AssertionSeal> {
  const merkleRoot = computeFlatKCRootV10(
    [{ subject: subjectOf(value), predicate: SUBJECT_PREDICATE, object: `"${value}"`, graph: '' }],
    [],
  );
  const reservedKaId = (BigInt(author.address) << 96n) | kaNumber;
  const typed = buildAuthorAttestationTypedData({
    chainId: 31337n,
    kav10Address: KAV10,
    merkleRoot,
    authorAddress: author.address,
    reservedKaId,
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  });
  const signature = ethers.Signature.from(await author.signTypedData(typed.domain, typed.types, typed.message));
  return {
    merkleRoot,
    authorAddress: author.address,
    authorAttestationR: ethers.getBytes(signature.r),
    authorAttestationVS: ethers.getBytes(signature.yParityAndS),
    authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1,
    chainId: 31337n,
    kav10Address: KAV10,
    reservedKaId,
    finalizedAtIso: '2026-10-18T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ualOf(author, kaNumber),
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    rootEntities: [],
  };
}

/** The share request a member's node sends, with its author seal. */
export async function relayedShareRequest(options: RelayedShareOptions = {}): Promise<Uint8Array> {
  const author = options.author ?? AUTHOR;
  const value = options.value ?? 'a report';
  const kaNumber = options.kaNumber ?? 7n;
  const contextGraphId = options.contextGraphId ?? RELAYED_CG;
  const seal = await sealOf(author, value, kaNumber);
  return encodeWorkspacePublishRequest({
    contextGraphId,
    nquads: new TextEncoder().encode(
      `<${subjectOf(value)}> <${SUBJECT_PREDICATE}> "${value}" <${contextGraphDataUri(contextGraphId)}> .`,
    ),
    manifest: [],
    publisherPeerId: options.publisherPeerId ?? '12D3KooWRelayedShareMember',
    shareOperationId: options.shareOperationId ?? `op-${value.replace(/[^A-Za-z0-9]/g, '-')}`,
    timestampMs: Date.now(),
    subGraphName: REPORTS,
    agentAddress: author.address.toLowerCase(),
    kaNumber: kaNumber.toString(),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ualOf(author, kaNumber),
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    ...sharedMemoryAuthorSealFields(options.assertionName ?? 'report-1', seal),
    ...options.request,
  });
}

/** `payload` in the gossip envelope `signer` signs at `signedAt`. */
export async function signedEnvelope(
  payload: Uint8Array,
  signer: ethers.Wallet = AUTHOR,
  options: { readonly contextGraphId?: string; readonly signedAt?: Date } = {},
): Promise<Uint8Array> {
  const contextGraphId = options.contextGraphId ?? RELAYED_CG;
  const timestamp = (options.signedAt ?? new Date()).toISOString();
  const signature = await signer.signMessage(
    computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId, timestamp, payload),
  );
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: signer.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
  });
}

/** A member's signed share, as the wire carries it. */
export async function relayedShare(options: RelayedShareOptions = {}): Promise<Uint8Array> {
  return signedEnvelope(await relayedShareRequest(options), options.signer ?? options.author ?? AUTHOR, {
    contextGraphId: options.contextGraphId,
    signedAt: options.signedAt,
  });
}

/** An envelope around `payload` that carries no signature. */
export function unsignedEnvelope(payload: Uint8Array, contextGraphId = RELAYED_CG): Uint8Array {
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: '',
    timestamp: new Date().toISOString(),
    signature: new Uint8Array(),
    payload,
  });
}

/** A sender-key payload of the graph. */
export function senderKeyPayload(contextGraphId = RELAYED_CG): Uint8Array {
  return encodeSwmSenderKeyMessage({
    version: '1',
    type: SWM_SENDER_KEY_MESSAGE_TYPE,
    contextGraphId,
    subGraphName: REPORTS,
    senderAgentAddress: AUTHOR.address,
    epochId: 'epoch-1',
    membershipHash: 'membership',
    messageIndex: 0,
    cipherAlgorithm: 'AES-256-GCM',
    nonce: new Uint8Array(12),
    ciphertext: new Uint8Array([1, 2, 3]),
    aadHash: new Uint8Array(32),
    senderKeySignature: new Uint8Array(65),
  });
}

/** A legacy encrypted payload of the graph. */
export function encryptedPayload(contextGraphId = RELAYED_CG): Uint8Array {
  return encodeEncryptedWorkspacePayload({
    version: '1',
    type: ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
    contextGraphId,
    senderIdentity: AUTHOR.address,
    operationId: 'op',
    shareOperationId: 'share-op',
    timestampMs: Date.now(),
    subGraphName: REPORTS,
    cipherAlgorithm: 'AES-256-GCM',
    nonce: new Uint8Array(12),
    ciphertext: new Uint8Array([1, 2, 3]),
    recipients: [],
    keyAgreementAlgorithm: 'X25519-HKDF-SHA256',
    ephemeralPublicKey: new Uint8Array(32),
  });
}
