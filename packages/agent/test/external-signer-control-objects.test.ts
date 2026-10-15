/**
 * RFC-64 control objects signed by an author key an external signer holds.
 * The signer is given the canonical unsigned object (`dkg_signControlObject`)
 * and recomputes its digest; a signer without the method signs the digest
 * with `eth_sign`. A digest is only ever sent while the producer has marked
 * the object it belongs to, and the signature verifies like a local one. A key
 * on the node signs the digest itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  connectRemoteSigners,
  verifyEip191ControlEnvelopeIssuerSignatureV1,
  type AuthorSigner,
  type ExternalAuthorSigners,
  type RemoteSigners,
} from '@origintrail-official/dkg-chain';
import {
  CONTROL_OBJECT_DIGEST_DOMAIN,
  canonicalizeUnsignedControlEnvelopeBytes,
  computeControlObjectDigest,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1,
  signRfc64ControlObjectExternallyV1,
  signingRfc64ControlObjectV1,
} from '../src/rfc64/external-author-control-signing-v1.js';
import { rfc64AuthorDigestSignerV1, signAndVerifyRfc64ControlEnvelopeV1 } from '../src/rfc64/control-envelope-signer-v1.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'control-payer-credential-a1b2c3d4e5f60718';
const AUTHOR_TOKEN = 'control-author-credential-8170f6e5d4c3b2a1';
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);

const started: FakeSigner[] = [];
const connections: RemoteSigners[] = [];
afterEach(async () => {
  while (connections.length > 0) connections.pop()!.destroy();
  while (started.length > 0) await started.pop()!.close();
});

async function authorSigner(unsupported: string[] = []): Promise<{ fake: FakeSigner; signer: AuthorSigner; authors: ExternalAuthorSigners }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [HARDHAT_KEYS.PUBLISHER] },
      { token: AUTHOR_TOKEN, keys: [author.privateKey] },
    ],
    unsupported,
  });
  started.push(fake);
  const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
  connections.push(remote);
  return { fake, signer: (await remote.authors!.signerFor(author.address))!, authors: remote.authors! };
}

function controlObject(issuer = author.address.toLowerCase()): UnsignedControlEnvelopeV1 {
  return {
    issuer,
    objectType: 'AuthorCatalogIssuerDelegationV1',
    payload: { authorAddress: issuer, contextGraphId: 'catalog-graph', effectiveAt: '1', expiresAt: '2' },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
}

describe('RFC-64 control objects signed by an author key the external signer holds', () => {
  it('shows the signer the canonical object, and the signature verifies as the issuer', async () => {
    const { fake, signer } = await authorSigner();
    const unsigned = controlObject();
    const objectDigest = computeControlObjectDigest(unsigned);
    const signature = await signingRfc64ControlObjectV1(unsigned, () => signRfc64ControlObjectExternallyV1(signer, objectDigest));

    const [request] = fake.calls(RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1);
    expect(request.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(request.params).toEqual([author.address.toLowerCase(), {
      domain: CONTROL_OBJECT_DIGEST_DOMAIN,
      envelope: new TextDecoder().decode(canonicalizeUnsignedControlEnvelopeBytes(unsigned)),
    }]);
    expect(fake.calls('eth_sign')).toEqual([]);
    const signed = { ...unsigned, objectDigest: ethers.hexlify(objectDigest), signature } as SignedControlEnvelopeV1;
    expect(verifyEip191ControlEnvelopeIssuerSignatureV1(signed)).toBeDefined();
  });

  it('signs through the producers\' signing step, and falls back to eth_sign for a signer without the method', async () => {
    const { fake, signer } = await authorSigner([RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1]);
    const unsigned = controlObject();
    const objectDigest = ethers.hexlify(computeControlObjectDigest(unsigned));
    const { envelope } = await signAndVerifyRfc64ControlEnvelopeV1(unsigned, objectDigest as never, {
      issuer: author.address.toLowerCase() as never,
      signDigest: rfc64AuthorDigestSignerV1(author.address, signer),
    });
    expect(envelope.signature).toBe(await author.signMessage(ethers.getBytes(objectDigest)));
    expect(fake.calls(RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1)).toHaveLength(1);
    expect(fake.calls('eth_sign').map((request) => request.params)).toEqual([[author.address.toLowerCase(), objectDigest]]);
  });

  it('never sends a digest without the object it belongs to', async () => {
    const { fake, signer } = await authorSigner();
    const unsigned = controlObject();
    await expect(signRfc64ControlObjectExternallyV1(signer, computeControlObjectDigest(unsigned)))
      .rejects.toThrow('signs only a control object it is shown');
    await expect(rfc64AuthorDigestSignerV1(author.address, signer)(computeControlObjectDigest(unsigned)))
      .rejects.toThrow('signs only a control object it is shown');
    await expect(signingRfc64ControlObjectV1(unsigned, () => signRfc64ControlObjectExternallyV1(signer, new Uint8Array(32))))
      .rejects.toThrow('is not the digest of the control object being signed');
    // An object issued by another account is refused by the signer, and the refusal is final.
    const foreign = controlObject(new ethers.Wallet(HARDHAT_KEYS.EXTRA3).address.toLowerCase());
    await expect(signingRfc64ControlObjectV1(foreign, () => signRfc64ControlObjectExternallyV1(signer, computeControlObjectDigest(foreign))))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(fake.calls('eth_sign')).toEqual([]);
  });

  it('has a key on the node sign the digest itself, marked or not', async () => {
    const unsigned = controlObject();
    const objectDigest = computeControlObjectDigest(unsigned);
    const expected = await author.signMessage(objectDigest);
    const local = rfc64AuthorDigestSignerV1(author.address, author);
    expect(await local(objectDigest)).toBe(expected);
    expect(await signingRfc64ControlObjectV1(unsigned, () => local(objectDigest))).toBe(expected);
  });

  it('is the author signer of a node whose author keys the external signer holds', async () => {
    const { fake, authors } = await authorSigner();
    const agent = Object.create(DKGAgent.prototype) as any;
    agent.config = { authorSigners: authors };
    agent.localAgents = new Map();
    agent.chain = { signMessageAs: () => Promise.reject(new Error('not a payer')) };
    const authorSignerV1 = agent.createRfc64CatalogAuthorSignerV1(author.address.toLowerCase());
    const unsigned = controlObject();
    const objectDigest = computeControlObjectDigest(unsigned);
    const signature = await signingRfc64ControlObjectV1(unsigned, () => authorSignerV1.signMessage(objectDigest));
    expect(signature).toBe(await author.signMessage(objectDigest));
    expect(fake.calls(RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1)).toHaveLength(1);
    // An author the signer does not hold is left to the chain adapter of a node that signs locally, as before.
    const other = agent.createRfc64CatalogAuthorSignerV1(new ethers.Wallet(HARDHAT_KEYS.EXTRA3).address.toLowerCase());
    await expect(other.signMessage(objectDigest)).rejects.toThrow('not a payer');
  });

  it('still signs through the chain adapter for an author it does not hold, as before', async () => {
    const compact = async (wallet: ethers.Wallet, message: Uint8Array) => {
      const signature = ethers.Signature.from(await wallet.signMessage(message));
      return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
    };
    const unsigned = controlObject();
    const objectDigest = computeControlObjectDigest(unsigned);
    for (const [chain, expected] of [
      [{ signMessageAs: (_address: string, message: Uint8Array) => compact(author, message) }, 'signs'],
      [{ signMessage: (message: Uint8Array) => compact(author, message) }, 'signs'],
      [{ signMessageAs: (_address: string, message: Uint8Array) => compact(new ethers.Wallet(HARDHAT_KEYS.EXTRA3), message) }, 'refuses'],
      [{}, 'has no signer'],
    ] as const) {
      const agent = Object.create(DKGAgent.prototype) as any;
      Object.assign(agent, { config: {}, localAgents: new Map(), chain });
      const signing = agent.createRfc64CatalogAuthorSignerV1(author.address.toLowerCase()).signMessage(objectDigest);
      if (expected === 'signs') expect(await signing).toBe(await author.signMessage(objectDigest));
      else if (expected === 'refuses') await expect(signing).rejects.toThrow('cannot sign for the confirmed KA author');
      else await expect(signing).rejects.toThrow('has no message signer');
    }
  });
});
