/**
 * Authenticated sync requests signed as the claimed agent or as the node
 * identity. One signing capability is resolved for the agent at the sync
 * boundary: its key held on the node, else an author key of the external
 * signer (never a payer), which signs the same 32-byte request digest
 * (EIP-191). The envelope builder only chooses the signing principal (a node
 * identity first, the agent's own signature when the request requires it) and
 * refuses a signature that does not recover to the claimed agent. An external
 * signer is given the request's signed fields (`dkg_signSyncRequest`) and
 * recomputes the digest itself; one without that method signs the digest
 * (`eth_sign`). A key on the node signs the digest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { RemoteSignerError, connectRemoteSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import { sendSyncRequest } from '../src/p2p/sync-transport.js';
import { UNRESTRICTED_SYNC_WORK } from '../src/sync/work-admission.js';
import { buildSyncRequestEnvelope, type SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import {
  SYNC_REQUEST_SIGNING_METHOD,
  chainSyncRequestSigner,
  claimedAgentSyncRequestSigner,
  syncRequestSigningPreimage,
  type SyncRequestSigner,
} from '../src/sync/auth/request-signing.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'sync-payer-credential-7d8e9f0a1b2c';
const AUTHOR_TOKEN = 'sync-author-credential-2c1b0a9f8e7d';
const TARGET_PEER = '12D3KooWBGwD31cyBRS98MzhVR1FxZ4aR9K8EhRre7qUAqWHpnhy';
const REQUESTER_PEER = '12D3KooWPUyUxXf1gQJ1pEmxVLScWT2z6EYDFxTxYgokV8RWRm8D';
const agentWallet = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const otherWallet = new ethers.Wallet(HARDHAT_KEYS.EXTRA3);
const payer = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER);
const DIGEST = ethers.getBytes(ethers.id('sync request digest'));

type BuildParams = Parameters<typeof buildSyncRequestEnvelope>[0];

function params(overrides: Partial<BuildParams> = {}): BuildParams {
  return {
    contextGraphId: 'public-graph',
    offset: 0,
    limit: 100,
    includeSharedMemory: true,
    targetPeerId: 'peer-target',
    requesterPeerId: 'peer-requester',
    needsAuth: true,
    computeSyncDigest: () => DIGEST,
    getIdentityId: async () => 0n,
    claimedAgentAddress: agentWallet.address,
    ...overrides,
  };
}

async function build(overrides: Partial<BuildParams>): Promise<Record<string, string>> {
  return JSON.parse(new TextDecoder().decode(await buildSyncRequestEnvelope(params(overrides))));
}

function signerOf(request: Record<string, string>): string {
  return ethers.recoverAddress(ethers.hashMessage(DIGEST), {
    r: request['requesterSignatureR']!,
    yParityAndS: request['requesterSignatureVS']!,
  });
}

const computeSyncDigest = (...args: Parameters<DKGAgent['computeSyncDigest']>) =>
  DKGAgent.prototype.computeSyncDigest.apply(undefined as never, args);

/** A request as the node builds it, with its real digest and peer IDs, as a signer validates them. */
function catchUpParams(overrides: Partial<BuildParams> = {}): BuildParams {
  return params({
    contextGraphId: 'catch-up-graph',
    limit: 500,
    includeSharedMemory: false,
    targetPeerId: TARGET_PEER,
    requesterPeerId: REQUESTER_PEER,
    phase: 'meta',
    computeSyncDigest,
    ...overrides,
  });
}

function parse(bytes: Uint8Array): SyncRequestEnvelope {
  return JSON.parse(new TextDecoder().decode(bytes)) as SyncRequestEnvelope;
}

function digestOf(request: SyncRequestEnvelope): Uint8Array {
  return computeSyncDigest(
    request.contextGraphId, request.offset, request.limit, request.includeSharedMemory,
    request.targetPeerId!, request.requesterPeerId!, request.requestId!, request.issuedAtMs!,
    request.requesterAgentAddress, request.authPurpose, request.authSelector,
  );
}

function recoveredSigner(request: SyncRequestEnvelope): string {
  return ethers.recoverAddress(ethers.hashMessage(digestOf(request)), {
    r: request.requesterSignatureR!,
    yParityAndS: request.requesterSignatureVS!,
  });
}

const fakes: FakeSigner[] = [];
const connections: RemoteSigners[] = [];
afterEach(async () => {
  while (connections.length > 0) connections.pop()!.destroy();
  while (fakes.length > 0) await fakes.pop()!.close();
});

/** A fake signer serving `payer` to the payer credential and the agent's key to the author credential. */
async function externalAuthors(unsupported: string[] = []): Promise<{ fake: FakeSigner; remote: RemoteSigners }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [payer.privateKey] },
      { token: AUTHOR_TOKEN, keys: [agentWallet.privateKey] },
    ],
    unsupported,
  });
  fakes.push(fake);
  const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
  connections.push(remote);
  return { fake, remote };
}

describe('sync request signing preimage', () => {
  it('carries the signed fields in digest order, the agent in lowercase, and no auth fields unless set', () => {
    const request: SyncRequestEnvelope = {
      contextGraphId: 'graph', offset: 7, limit: 500, includeSharedMemory: true,
      targetPeerId: TARGET_PEER, requesterPeerId: REQUESTER_PEER, requestId: '0x0102030405060708090a0b0c',
      issuedAtMs: 1_700_000_000_000, requesterAgentAddress: agentWallet.address,
      phase: 'data', sinceBatchId: '5', pageRowsHint: 8192,
    };
    const preimage = syncRequestSigningPreimage(request);
    expect(Object.keys(preimage)).toEqual([
      'contextGraphId', 'offset', 'limit', 'includeSharedMemory', 'targetPeerId',
      'requesterPeerId', 'requestId', 'issuedAtMs', 'requesterAgentAddress',
    ]);
    expect(preimage.requesterAgentAddress).toBe(agentWallet.address.toLowerCase());
    expect(syncRequestSigningPreimage({ ...request, authSelector: '0xabc' })).toMatchObject({ authPurpose: '', authSelector: '0xabc' });
    expect(syncRequestSigningPreimage({ contextGraphId: 'g', offset: 0, limit: 1, includeSharedMemory: false })).toEqual({
      contextGraphId: 'g', offset: 0, limit: 1, includeSharedMemory: false, targetPeerId: '',
      requesterPeerId: '', requestId: '', issuedAtMs: 0, requesterAgentAddress: '',
    });
  });
});

describe('sync requests signed as the claimed agent', () => {
  it('are signed over the request digest by the claimed agent\'s signer, which must recover to the agent', async () => {
    const claimedAgentSigner = vi.fn<SyncRequestSigner>(async (digest) => agentWallet.signMessage(digest));
    const request = await build({ claimedAgentSigner });
    // The signer is given the digest and its preimage, the request's signed fields.
    expect(claimedAgentSigner).toHaveBeenCalledWith(DIGEST, syncRequestSigningPreimage(request as unknown as SyncRequestEnvelope));
    expect(request['requesterIdentityId']).toBe('0');
    expect(request['requesterAgentAddress']).toBe(agentWallet.address);
    expect(signerOf(request)).toBe(agentWallet.address);

    // A signature by another key is refused: no request is built.
    await expect(build({ claimedAgentSigner: async (digest) => otherWallet.signMessage(digest) }))
      .rejects.toThrow(`the signature does not recover to claimed agent ${agentWallet.address}`);
    // Without a signer, the request still cannot be authenticated.
    await expect(build({})).rejects.toThrow(`missing signing key for claimed agent ${agentWallet.address}`);
  });

  it('use the node identity when it has one, and the agent\'s signer for agent-signed requests', async () => {
    const claimedAgentSigner = vi.fn<SyncRequestSigner>(async (digest) => agentWallet.signMessage(digest));
    const identitySignature = ethers.Signature.from(await otherWallet.signMessage(DIGEST));
    const signMessage = vi.fn(async () => ({ r: ethers.getBytes(identitySignature.r), vs: ethers.getBytes(identitySignature.yParityAndS) }));
    const identity = await build({ claimedAgentSigner, getIdentityId: async () => 7n, signMessage });
    expect(identity['requesterIdentityId']).toBe('7');
    expect(signMessage).toHaveBeenCalledWith(DIGEST, syncRequestSigningPreimage(identity as unknown as SyncRequestEnvelope));
    expect(claimedAgentSigner).not.toHaveBeenCalled();

    // Member recovery and forced agent signatures are the agent's own, identity or not.
    const recovery = await build({ claimedAgentSigner, recovery: true, getIdentityId: async () => 7n });
    expect(recovery['requesterIdentityId']).toBe('0');
    expect(signerOf(recovery)).toBe(agentWallet.address);
    const forced = await build({ claimedAgentSigner, forceClaimedAgentSignature: true, authPurpose: 'purpose', authSelector: '0x12' });
    expect(signerOf(forced)).toBe(agentWallet.address);
    expect(claimedAgentSigner).toHaveBeenCalledTimes(2);
    // The auth purpose and selector are signed fields, so they are in the preimage.
    expect(claimedAgentSigner.mock.calls[1]![1]).toMatchObject({ authPurpose: 'purpose', authSelector: '0x12' });
    await expect(build({ recovery: true })).rejects.toThrow('missing claimed agent signing key');
  });

  it('resolve one signer for the agent: its key on the node first, else an author key of the external signer', async () => {
    // A signer without dkg_signSyncRequest: the author key signs the digest itself.
    const { fake, remote } = await externalAuthors([SYNC_REQUEST_SIGNING_METHOD]);
    const authors = remote.authors;
    const requestsAfterConnect = fake.requests.length;
    // The account lists are known from connecting, so a lookup is seen as a call, not as a request.
    const lookups = vi.spyOn(authors!, 'signerFor');
    // Not a local agent, or one the node can sign for in neither way: no signer.
    expect(claimedAgentSyncRequestSigner(authors, agentWallet.address, undefined)).toBeUndefined();
    expect(claimedAgentSyncRequestSigner(authors, undefined, {})).toBeUndefined();
    expect(claimedAgentSyncRequestSigner(undefined, agentWallet.address, {})).toBeUndefined();

    // A key held on the node signs on the node, even with author keys configured.
    const local = await build({ claimedAgentSigner: claimedAgentSyncRequestSigner(authors, agentWallet.address, { privateKey: agentWallet.privateKey }) });
    expect(signerOf(local)).toBe(agentWallet.address);
    expect(fake.requests).toHaveLength(requestsAfterConnect);

    // Also a key stored without its 0x prefix.
    const unprefixed = await build({
      claimedAgentSigner: claimedAgentSyncRequestSigner(authors, agentWallet.address, { privateKey: agentWallet.privateKey.slice(2) }),
    });
    expect(signerOf(unprefixed)).toBe(agentWallet.address);
    expect(fake.requests).toHaveLength(requestsAfterConnect);
    expect(lookups).not.toHaveBeenCalled();
    // When the node identity signs the request, the agent's signer is never resolved: the signer is not asked.
    const identitySignature = ethers.Signature.from(await otherWallet.signMessage(DIGEST));
    const byIdentity = await build({
      claimedAgentSigner: claimedAgentSyncRequestSigner(authors, agentWallet.address, {}),
      getIdentityId: async () => 7n,
      signMessage: async () => ({ r: ethers.getBytes(identitySignature.r), vs: ethers.getBytes(identitySignature.yParityAndS) }),
    });
    expect(byIdentity['requesterIdentityId']).toBe('7');
    expect(fake.requests).toHaveLength(requestsAfterConnect);
    expect(lookups).not.toHaveBeenCalled();

    // Otherwise the author key is looked up only when a request is signed, and signs it once.
    const external = claimedAgentSyncRequestSigner(authors, agentWallet.address, {});
    expect(fake.requests).toHaveLength(requestsAfterConnect);
    expect(lookups).not.toHaveBeenCalled();
    expect(signerOf(await build({ claimedAgentSigner: external }))).toBe(agentWallet.address);
    expect(lookups).toHaveBeenCalledTimes(1);
    const signed = fake.calls('eth_sign');
    expect(signed).toHaveLength(1);
    expect(signed[0]!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(signed[0]!.params).toEqual([agentWallet.address.toLowerCase(), ethers.hexlify(DIGEST)]);

    // A payer is not an author key: nothing is signed, and the failure is the signer's, so final.
    await expect(build({
      claimedAgentAddress: payer.address,
      claimedAgentSigner: claimedAgentSyncRequestSigner(authors, payer.address, {}),
    })).rejects.toMatchObject({
      code: 'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE',
      message: `Cannot sign a sync request as ${payer.address}: it is not an author key of the external signer`,
    });
    expect(fake.calls('eth_sign')).toHaveLength(1);
  });
});

describe('sync requests an external signer can check', () => {
  it('ask an author key with dkg_signSyncRequest and the signed fields, which the signer validates and recomputes', async () => {
    const { fake, remote } = await externalAuthors();
    const claimedAgentSigner = claimedAgentSyncRequestSigner(remote.authors, agentWallet.address, {});
    const request = parse(await buildSyncRequestEnvelope(catchUpParams({ claimedAgentSigner })));
    expect(recoveredSigner(request)).toBe(agentWallet.address);
    const [call] = fake.calls(SYNC_REQUEST_SIGNING_METHOD);
    expect(call!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(call!.params).toEqual([agentWallet.address.toLowerCase(), syncRequestSigningPreimage(request)]);
    expect(fake.calls('eth_sign')).toEqual([]);

    // A key on the node signs the digest itself; the signer is not asked.
    const local = claimedAgentSyncRequestSigner(remote.authors, agentWallet.address, { privateKey: agentWallet.privateKey });
    expect(recoveredSigner(parse(await buildSyncRequestEnvelope(catchUpParams({ claimedAgentSigner: local })))))
      .toBe(agentWallet.address);
    expect(fake.calls(SYNC_REQUEST_SIGNING_METHOD)).toHaveLength(1);
  });

  it('fall back to eth_sign over the digest for a signer without the method, which is not offered it again', async () => {
    const { fake, remote } = await externalAuthors([SYNC_REQUEST_SIGNING_METHOD]);
    const claimedAgentSigner = claimedAgentSyncRequestSigner(remote.authors, agentWallet.address, {});
    const first = parse(await buildSyncRequestEnvelope(catchUpParams({ claimedAgentSigner })));
    const second = parse(await buildSyncRequestEnvelope(catchUpParams({ claimedAgentSigner, offset: 500 })));
    expect([recoveredSigner(first), recoveredSigner(second)]).toEqual([agentWallet.address, agentWallet.address]);
    expect(fake.calls(SYNC_REQUEST_SIGNING_METHOD)).toHaveLength(1);
    expect(fake.calls('eth_sign').map((call) => call.params)).toEqual([
      [agentWallet.address.toLowerCase(), ethers.hexlify(digestOf(first))],
      [agentWallet.address.toLowerCase(), ethers.hexlify(digestOf(second))],
    ]);
  });

  it('do not sign a sync page again after the external signer failed, while other failures are retried', async () => {
    const attempt = async (failure: Error) => {
      const requestFactory = vi.fn(async (): Promise<Uint8Array> => { throw failure; });
      await expect(sendSyncRequest({
        remotePeerId: TARGET_PEER,
        timeoutMs: 1_000,
        retryAttempts: 3,
        contextGraphId: 'catch-up-graph',
        offset: 0,
        workAdmission: UNRESTRICTED_SYNC_WORK,
        requestFactory,
        send: vi.fn(),
        protocolId: '/dkg/10.0.2/sync',
        onRetry: () => {},
      } as never)).rejects.toBe(failure);
      return requestFactory.mock.calls.length;
    };
    expect(await attempt(new RemoteSignerError('REMOTE_SIGNER_REJECTED', 'refused by policy'))).toBe(1);
    expect(await attempt(new RemoteSignerError('REMOTE_SIGNER_TIMEOUT', 'no answer'))).toBe(1);
    expect(await attempt(new Error('chain read failed'))).toBe(3);
  }, 30_000);

  it('sign as the node identity with the preimage when the chain adapter takes it', async () => {
    const signed ={ r: new Uint8Array(32).fill(1), vs: new Uint8Array(32).fill(2) };
    const signMessageWithPreimage = vi.fn(async () => signed);
    const signMessage = vi.fn(async () => signed);
    const preimage = syncRequestSigningPreimage({ contextGraphId: 'g', offset: 0, limit: 1, includeSharedMemory: false });
    const digest = new Uint8Array(32).fill(3);

    expect(await chainSyncRequestSigner({ signMessage, signMessageWithPreimage })!(digest, preimage)).toBe(signed);
    expect(signMessageWithPreimage).toHaveBeenCalledWith({ method: SYNC_REQUEST_SIGNING_METHOD, preimage, message: digest });
    expect(signMessage).not.toHaveBeenCalled();

    expect(await chainSyncRequestSigner({ signMessage })!(digest, preimage)).toBe(signed);
    expect(signMessage).toHaveBeenCalledWith(digest, preimage);
    expect(chainSyncRequestSigner({})).toBeUndefined();
  });
});
