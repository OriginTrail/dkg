import { peerIdFromString } from '@libp2p/peer-id';
import {
  ed25519Verify,
  PROTOCOL_NETWORK_IDENTITY,
  type DkgNetworkIdentity,
} from '@origintrail-official/dkg-core';

export const NETWORK_IDENTITY_PROOF_VERSION = 1;
export const NETWORK_IDENTITY_PROOF_KIND = 'ed25519-peer-id';

export interface NetworkIdentityRequest {
  version: typeof NETWORK_IDENTITY_PROOF_VERSION;
  nonce: string;
  requesterPeerId: string;
  networkId: string;
  genesisId?: string;
  chainId?: string;
}

export interface NetworkIdentityResponse {
  version: typeof NETWORK_IDENTITY_PROOF_VERSION;
  peerId: string;
  networkId: string;
  genesisId?: string;
  chainId?: string;
  networkConfigName?: string;
  proofKind: typeof NETWORK_IDENTITY_PROOF_KIND;
  signature: string;
}

export interface VerifyNetworkIdentityResponseInput {
  response: unknown;
  remotePeerId: string;
  localIdentity: DkgNetworkIdentity;
  nonce: string;
  requesterPeerId: string;
}

export interface VerifyNetworkIdentityResponseResult {
  ok: boolean;
  reason?: string;
}

export function makeNetworkIdentityRequest(input: {
  nonce: string;
  requesterPeerId: string;
  identity: DkgNetworkIdentity;
}): NetworkIdentityRequest {
  return {
    version: NETWORK_IDENTITY_PROOF_VERSION,
    nonce: input.nonce,
    requesterPeerId: input.requesterPeerId,
    networkId: input.identity.networkId,
    genesisId: input.identity.genesisId,
    chainId: input.identity.chainId,
  };
}

export function networkIdentityProofPayload(input: {
  nonce: string;
  requesterPeerId: string;
  responderPeerId: string;
  networkId: string;
  genesisId?: string;
  chainId?: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: NETWORK_IDENTITY_PROOF_VERSION,
    protocol: PROTOCOL_NETWORK_IDENTITY,
    nonce: input.nonce,
    requesterPeerId: input.requesterPeerId,
    responderPeerId: input.responderPeerId,
    networkId: input.networkId,
    genesisId: input.genesisId ?? null,
    chainId: input.chainId ?? null,
  }));
}

export async function signNetworkIdentityResponse(input: {
  request: NetworkIdentityRequest;
  identity: DkgNetworkIdentity;
  responderPeerId: string;
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
}): Promise<NetworkIdentityResponse> {
  const payload = networkIdentityProofPayload({
    nonce: input.request.nonce,
    requesterPeerId: input.request.requesterPeerId,
    responderPeerId: input.responderPeerId,
    networkId: input.identity.networkId,
    genesisId: input.identity.genesisId,
    chainId: input.identity.chainId,
  });
  const signature = await input.sign(payload);
  return {
    version: NETWORK_IDENTITY_PROOF_VERSION,
    peerId: input.responderPeerId,
    networkId: input.identity.networkId,
    genesisId: input.identity.genesisId,
    chainId: input.identity.chainId,
    networkConfigName: input.identity.networkConfigName,
    proofKind: NETWORK_IDENTITY_PROOF_KIND,
    signature: Buffer.from(signature).toString('base64'),
  };
}

export function parseNetworkIdentityRequest(data: Uint8Array): NetworkIdentityRequest {
  const value = JSON.parse(new TextDecoder().decode(data)) as Partial<NetworkIdentityRequest>;
  if (value.version !== NETWORK_IDENTITY_PROOF_VERSION) {
    throw new Error('unsupported network identity request version');
  }
  if (!isNonEmptyString(value.nonce)) throw new Error('missing network identity nonce');
  if (!isNonEmptyString(value.requesterPeerId)) throw new Error('missing network identity requester peer id');
  if (!isNonEmptyString(value.networkId)) throw new Error('missing network identity network id');
  return {
    version: NETWORK_IDENTITY_PROOF_VERSION,
    nonce: value.nonce,
    requesterPeerId: value.requesterPeerId,
    networkId: value.networkId,
    genesisId: isNonEmptyString(value.genesisId) ? value.genesisId : undefined,
    chainId: isNonEmptyString(value.chainId) ? value.chainId : undefined,
  };
}

export async function verifyNetworkIdentityResponse(
  input: VerifyNetworkIdentityResponseInput,
): Promise<VerifyNetworkIdentityResponseResult> {
  const response = input.response as Partial<NetworkIdentityResponse>;
  if (response.version !== NETWORK_IDENTITY_PROOF_VERSION) return { ok: false, reason: 'unsupported proof version' };
  if (response.peerId !== input.remotePeerId) return { ok: false, reason: 'peer id mismatch' };
  if (response.networkId !== input.localIdentity.networkId) return { ok: false, reason: 'network id mismatch' };
  if (input.localIdentity.genesisId && response.genesisId !== input.localIdentity.genesisId) {
    return { ok: false, reason: 'genesis id mismatch' };
  }
  if (input.localIdentity.chainId && response.chainId !== input.localIdentity.chainId) {
    return { ok: false, reason: 'chain id mismatch' };
  }
  if (response.proofKind !== NETWORK_IDENTITY_PROOF_KIND) return { ok: false, reason: 'unsupported proof kind' };
  if (!isNonEmptyString(response.signature)) return { ok: false, reason: 'missing signature' };

  let publicKey: Uint8Array | undefined;
  try {
    const peerId = peerIdFromString(input.remotePeerId);
    publicKey = peerId.publicKey?.raw;
  } catch (err) {
    return { ok: false, reason: `invalid remote peer id: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!publicKey) return { ok: false, reason: 'remote peer id has no embedded public key' };

  const payload = networkIdentityProofPayload({
    nonce: input.nonce,
    requesterPeerId: input.requesterPeerId,
    responderPeerId: input.remotePeerId,
    networkId: input.localIdentity.networkId,
    genesisId: input.localIdentity.genesisId,
    chainId: input.localIdentity.chainId,
  });
  const signature = Buffer.from(response.signature, 'base64');
  const valid = await ed25519Verify(signature, payload, publicKey);
  return valid ? { ok: true } : { ok: false, reason: 'invalid signature' };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
