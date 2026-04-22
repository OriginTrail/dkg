import { ethers } from 'ethers';

export interface SyncRequestEnvelope {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
  phase?: 'data' | 'meta';
}

interface BuildSyncRequestParams {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  targetPeerId: string;
  requesterPeerId: string;
  phase?: 'data' | 'meta';
  needsAuth: boolean;
  computeSyncDigest: (
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string,
    requestId: string,
    issuedAtMs: number,
  ) => Uint8Array;
  getIdentityId: () => Promise<bigint>;
  signMessage?: (digest: Uint8Array) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
  defaultAgentAddress?: string;
  defaultAgentPrivateKey?: string;
}

export async function buildSyncRequestEnvelope(params: BuildSyncRequestParams): Promise<Uint8Array> {
  const {
    contextGraphId,
    offset,
    limit,
    includeSharedMemory,
    targetPeerId,
    requesterPeerId,
    phase,
    needsAuth,
    computeSyncDigest,
    getIdentityId,
    signMessage,
    defaultAgentAddress,
    defaultAgentPrivateKey,
  } = params;

  if (!needsAuth) {
    const prefix = includeSharedMemory ? `workspace:${contextGraphId}` : contextGraphId;
    const phaseSuffix = phase === 'meta' ? '|meta' : '';
    return new TextEncoder().encode(`${prefix}|${offset}|${limit}${phaseSuffix}`);
  }

  const request: SyncRequestEnvelope = {
    contextGraphId,
    offset,
    limit,
    includeSharedMemory,
    targetPeerId,
    requesterPeerId,
    requestId: ethers.hexlify(ethers.randomBytes(12)),
    issuedAtMs: Date.now(),
  };
  if (phase) request.phase = phase;

  const digest = computeSyncDigest(
    request.contextGraphId,
    request.offset,
    request.limit,
    request.includeSharedMemory,
    request.targetPeerId!,
    request.requesterPeerId!,
    request.requestId!,
    request.issuedAtMs!,
  );

  const identityId = await getIdentityId();
  if (identityId > 0n && typeof signMessage === 'function') {
    const signature = await signMessage(digest);
    request.requesterIdentityId = identityId.toString();
    request.requesterSignatureR = ethers.hexlify(signature.r);
    request.requesterSignatureVS = ethers.hexlify(signature.vs);
  } else if (defaultAgentAddress && defaultAgentPrivateKey) {
    const wallet = new ethers.Wallet(defaultAgentPrivateKey);
    const sig = ethers.Signature.from(await wallet.signMessage(digest));
    request.requesterIdentityId = '0';
    request.requesterAgentAddress = defaultAgentAddress;
    request.requesterSignatureR = ethers.hexlify(sig.r);
    request.requesterSignatureVS = ethers.hexlify(sig.yParityAndS);
  }

  if (needsAuth && (!request.requesterSignatureR || !request.requesterSignatureVS)) {
    const signingTarget = defaultAgentAddress ? `default agent ${defaultAgentAddress}` : 'node identity';
    throw new Error(`Cannot build authenticated sync request for "${contextGraphId}": missing signing key for ${signingTarget}`);
  }

  return new TextEncoder().encode(JSON.stringify(request));
}
