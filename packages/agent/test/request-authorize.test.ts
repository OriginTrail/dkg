import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { authorizePrivateSyncRequest } from '../src/sync/auth/request-authorize.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

/**
 * Tests for the private-sync auth gate (`authorizePrivateSyncRequest`).
 *
 * Special focus on the agent-delegation path added by the refactor of
 * the V10 invite flow:
 *   - approved delegateeOpKey (recovered signer match) must allow
 *   - approved delegateePeer (transport carrier match) must allow
 *   - both must be ignored when the lists are empty
 *   - legacy agent-gate / participant / peer-allowlist gates still work
 *   - replay & timing checks still fire before the auth lookup
 */

const LOCAL_PEER = '12D3KooWLocalCurator';
const REMOTE_PEER = '12D3KooWRemoteJoiner';
const CG_ID = 'unit-test-cg';

// Deterministic per-input digest so the verifier recovers the exact
// signer regardless of envelope content. Bound to the request's
// `issuedAtMs` AND `requesterAgentAddress` so different envelopes
// produce different digests — and so post-signing tampering with the
// "on behalf of" agent claim invalidates the signature recovery
// (see `denies when requesterAgentAddress is tampered after signing`).
function computeDigestStub(
  _cg: string,
  _offset: number,
  _limit: number,
  _includeSWM: boolean,
  targetPeerId: string,
  requesterPeerId: string,
  requestId: string,
  issuedAtMs: number,
  requesterAgentAddress: string | undefined,
): Uint8Array {
  return ethers.getBytes(
    ethers.solidityPackedKeccak256(
      ['string', 'string', 'string', 'uint256', 'string'],
      [targetPeerId, requesterPeerId, requestId, issuedAtMs, (requesterAgentAddress ?? '').toLowerCase()],
    ),
  );
}

interface BuildEnvelopeOptions {
  signer: ethers.Wallet;
  identityId?: string;
  remotePeerId?: string;
  issuedAtMs?: number;
  requestId?: string;
  /**
   * When `identityId` is "0" (or unset), the auth path requires
   * `requesterAgentAddress` and asserts it matches the recovered
   * signer. Set this when simulating an agent-signed envelope (legacy
   * back-compat path); leave undefined when simulating an op-key-signed
   * envelope with a chain identity.
   */
  requesterAgentAddress?: string;
}

async function buildSignedEnvelope(
  opts: BuildEnvelopeOptions,
): Promise<{ envelope: SyncRequestEnvelope; remotePeerId: string }> {
  const remotePeerId = opts.remotePeerId ?? REMOTE_PEER;
  const issuedAtMs = opts.issuedAtMs ?? Date.now();
  const requestId = opts.requestId ?? ethers.hexlify(ethers.randomBytes(12));
  const digest = computeDigestStub(
    CG_ID, 0, 100, false, LOCAL_PEER, remotePeerId, requestId, issuedAtMs,
    opts.requesterAgentAddress,
  );
  const sig = ethers.Signature.from(await opts.signer.signMessage(digest));
  const envelope: SyncRequestEnvelope = {
    contextGraphId: CG_ID,
    offset: 0,
    limit: 100,
    includeSharedMemory: false,
    targetPeerId: LOCAL_PEER,
    requesterPeerId: remotePeerId,
    requestId,
    issuedAtMs,
    requesterIdentityId: opts.identityId ?? '0',
    requesterSignatureR: ethers.hexlify(sig.r),
    requesterSignatureVS: ethers.hexlify(sig.yParityAndS),
    ...(opts.requesterAgentAddress ? { requesterAgentAddress: opts.requesterAgentAddress } : {}),
  };
  return { envelope, remotePeerId };
}

interface AuthCallParams {
  envelope: SyncRequestEnvelope;
  remotePeerId: string;
  participants?: string[] | null;
  agentGateAddresses?: string[] | null;
  allowedPeers?: string[] | null;
  /**
   * Per-agent map of delegated peer-ids. Test helper accepts either
   * the raw Map or a sugar object `{[agentLower]: peerIds}` so test
   * cases stay readable.
   */
  allowedDelegateePeers?: Map<string, string[]> | Record<string, string[]>;
  allowedDelegateeKeys?: Map<string, string[]> | Record<string, string[]>;
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
}

function toMap(input: Map<string, string[]> | Record<string, string[]> | undefined): Map<string, string[]> {
  if (!input) return new Map();
  if (input instanceof Map) return input;
  return new Map(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]));
}

async function callAuth(params: AuthCallParams): Promise<{ allowed: boolean; logs: string[] }> {
  const logs: string[] = [];
  const ctx = { agentId: 'sync', operationId: 'test' } as any;
  const peersMap = toMap(params.allowedDelegateePeers);
  const keysMap = toMap(params.allowedDelegateeKeys);
  const allowed = await authorizePrivateSyncRequest({
    ctx,
    request: params.envelope,
    remotePeerId: params.remotePeerId,
    localPeerId: LOCAL_PEER,
    syncAuthMaxAgeMs: 90_000,
    seenRequestIds: new Map(),
    computeSyncDigest: computeDigestStub,
    verifyIdentity: params.verifyIdentity ?? (async () => true),
    getParticipants: async () => params.participants ?? null,
    getAllowedPeers: async () => params.allowedPeers ?? null,
    getAgentGateAddresses: async () => params.agentGateAddresses ?? null,
    getAllowedDelegateePeers: async () => peersMap,
    getAllowedDelegateeKeys: async () => keysMap,
    refreshMetaFromCurator: async () => false,
    logWarn: (_c, m) => logs.push(`WARN: ${m}`),
    logInfo: (_c, m) => logs.push(`INFO: ${m}`),
  });
  return { allowed, logs };
}

describe('authorizePrivateSyncRequest — agent-delegation path', () => {
  let nodeOpKey: ethers.Wallet;
  let agentAddress: string;

  beforeEach(() => {
    nodeOpKey = ethers.Wallet.createRandom();
    agentAddress = ethers.Wallet.createRandom().address;
  });

  it('allows when recovered op-key signer matches an approved delegateeOpKey for the claimed agent', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    const { allowed, logs } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedPeers: null,
      allowedDelegateeKeys: { [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()] },
    });
    expect(allowed).toBe(true);
    expect(logs.join('\n')).toMatch(/delegateeAllowed=true/);
  });

  it('allows when remote peer-id matches an approved delegateePeer for the claimed agent', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    const { allowed, logs } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedPeers: null,
      allowedDelegateePeers: { [agentAddress.toLowerCase()]: [remotePeerId] },
    });
    expect(allowed).toBe(true);
    expect(logs.join('\n')).toMatch(/delegateeAllowed=true/);
  });

  it('denies when neither delegatee identifier matches AND legacy gates miss', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    const otherKey = ethers.Wallet.createRandom().address.toLowerCase();
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedPeers: null,
      allowedDelegateePeers: { [agentAddress.toLowerCase()]: ['12D3KooWNotThisPeer'] },
      allowedDelegateeKeys: { [agentAddress.toLowerCase()]: [otherKey] },
    });
    expect(allowed).toBe(false);
  });

  it('denies when delegation exists for agent A but envelope claims agent B (cross-principal)', async () => {
    // Agent B's node tries to use Agent A's delegated op-key. Each
    // claim must be cross-checked against the SPECIFIC agent's
    // delegation entity — graph-wide union would silently allow this.
    const agentA = ethers.Wallet.createRandom().address;
    const agentB = ethers.Wallet.createRandom().address;
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentB, // claims to act for B
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      // Only A has a delegation; B does not.
      allowedDelegateeKeys: { [agentA.toLowerCase()]: [nodeOpKey.address.toLowerCase()] },
    });
    expect(allowed).toBe(false);
  });

  it('denies when requesterAgentAddress is tampered after signing (digest binding)', async () => {
    // Build a properly signed envelope claiming agentAddress, then
    // overwrite the field with a different agent post-signing. The
    // digest commits to `requesterAgentAddress`, so signature
    // recovery on the auth side produces a different signer for the
    // tampered envelope and the per-agent delegation lookup misses.
    const otherAgent = ethers.Wallet.createRandom().address;
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    envelope.requesterAgentAddress = otherAgent;
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      // Both agents have a valid delegation for the same op-key.
      // The only thing stopping the swap is the digest binding.
      allowedDelegateeKeys: {
        [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()],
        [otherAgent.toLowerCase()]: [nodeOpKey.address.toLowerCase()],
      },
    });
    expect(allowed).toBe(false);
  });

  it('denies the delegatee path when envelope omits requesterAgentAddress (no principal claim)', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      // requesterAgentAddress intentionally omitted
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      allowedDelegateeKeys: { [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()] },
    });
    expect(allowed).toBe(false);
  });

  it('falls back to legacy agent-gate when delegatee lists are empty (back-compat)', async () => {
    const agentWallet = ethers.Wallet.createRandom();
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: agentWallet,
      requesterAgentAddress: agentWallet.address,
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentWallet.address],
      agentGateAddresses: [agentWallet.address],
      allowedPeers: null,
      allowedDelegateePeers: [],
      allowedDelegateeKeys: [],
    });
    expect(allowed).toBe(true);
  });

  it('does NOT consider a key-only match valid when only delegateePeer list is consulted', async () => {
    // Sanity: key match triggers via allowedDelegateeKeys list, not allowedDelegateePeers.
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedDelegateePeers: { [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()] }, // wrong list
    });
    expect(allowed).toBe(false);
  });

  it('rejects a malformed envelope (missing signature) before consulting delegatee lists', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    delete (envelope as any).requesterSignatureR;
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      allowedDelegateeKeys: { [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()] },
    });
    expect(allowed).toBe(false);
  });

  it('rejects a stale envelope (older than syncAuthMaxAgeMs) even with a valid delegation', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
      issuedAtMs: Date.now() - 200_000,
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      allowedDelegateeKeys: { [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()] },
    });
    expect(allowed).toBe(false);
  });

  it('rejects replay (same requestId twice) even with a valid delegation', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    const seen = new Map<string, number>();
    const args = {
      ctx: {} as any,
      request: envelope,
      remotePeerId,
      localPeerId: LOCAL_PEER,
      syncAuthMaxAgeMs: 90_000,
      seenRequestIds: seen,
      computeSyncDigest: computeDigestStub,
      verifyIdentity: async () => true,
      getParticipants: async () => null,
      getAllowedPeers: async () => null,
      getAgentGateAddresses: async () => null,
      getAllowedDelegateePeers: async () => new Map<string, string[]>(),
      getAllowedDelegateeKeys: async () => new Map([[agentAddress.toLowerCase(), [nodeOpKey.address.toLowerCase()]]]),
      refreshMetaFromCurator: async () => false,
      logWarn: () => {},
      logInfo: () => {},
    };
    const first = await authorizePrivateSyncRequest(args);
    const second = await authorizePrivateSyncRequest(args);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('refreshes meta from curator when initial check denies, then re-checks delegatee lists', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    let refreshed = false;
    const callsToGetKeys: string[] = [];
    const allowed = await authorizePrivateSyncRequest({
      ctx: {} as any,
      request: envelope,
      remotePeerId,
      localPeerId: LOCAL_PEER,
      syncAuthMaxAgeMs: 90_000,
      seenRequestIds: new Map(),
      computeSyncDigest: computeDigestStub,
      verifyIdentity: async () => true,
      getParticipants: async () => null,
      getAllowedPeers: async () => null,
      getAgentGateAddresses: async () => null,
      getAllowedDelegateePeers: async () => new Map<string, string[]>(),
      getAllowedDelegateeKeys: async () => {
        callsToGetKeys.push(refreshed ? 'after-refresh' : 'before-refresh');
        return refreshed
          ? new Map([[agentAddress.toLowerCase(), [nodeOpKey.address.toLowerCase()]]])
          : new Map<string, string[]>();
      },
      refreshMetaFromCurator: async () => {
        refreshed = true;
        return true;
      },
      logWarn: () => {},
      logInfo: () => {},
    });
    expect(allowed).toBe(true);
    expect(callsToGetKeys).toEqual(['before-refresh', 'after-refresh']);
  });

  it('rejects when verifyIdentity fails even if delegatee key would match', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '7',
      requesterAgentAddress: agentAddress,
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      allowedDelegateeKeys: { [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()] },
      verifyIdentity: async () => false,
    });
    expect(allowed).toBe(false);
  });

  it('legacy AND-gate (peer-list AND agent-gate both present) still requires both to match', async () => {
    const agentWallet = ethers.Wallet.createRandom();
    // Build two distinct envelopes so the second isn't rejected as a replay.
    const { envelope: env1, remotePeerId } = await buildSignedEnvelope({
      signer: agentWallet,
      requesterAgentAddress: agentWallet.address,
    });
    const { envelope: env2 } = await buildSignedEnvelope({
      signer: agentWallet,
      requesterAgentAddress: agentWallet.address,
      requestId: ethers.hexlify(ethers.randomBytes(12)),
    });
    const { allowed: deniedByPeer } = await callAuth({
      envelope: env1,
      remotePeerId,
      participants: null,
      agentGateAddresses: [agentWallet.address],
      allowedPeers: ['12D3KooWNotThisPeer'],
    });
    expect(deniedByPeer).toBe(false);

    const { allowed: bothPass } = await callAuth({
      envelope: env2,
      remotePeerId,
      participants: null,
      agentGateAddresses: [agentWallet.address],
      allowedPeers: [remotePeerId],
    });
    expect(bothPass).toBe(true);
  });

  it('delegatee match short-circuits the legacy AND-gate', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      requesterAgentAddress: agentAddress,
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: null,
      agentGateAddresses: [agentAddress], // signer is op-key, not agent
      allowedPeers: ['12D3KooWNotThisPeer'],
      allowedDelegateeKeys: { [agentAddress.toLowerCase()]: [nodeOpKey.address.toLowerCase()] },
    });
    expect(allowed).toBe(true);
  });
});
