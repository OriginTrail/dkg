/**
 * Author keys held by an external signer.
 *
 * The author of a published knowledge asset is its owner, and can be a
 * different key than the operational wallets paying for transactions. With an
 * external signer both can live outside the node, and each agent can have its
 * own author key: an agent registered with an address served by the external
 * signer's author accounts is a self-sovereign agent (the node stores no key
 * for it) whose author attestations the node requests from the signer.
 */
import { ethers } from 'ethers';
import type { EvmSigner, ExternalAuthorSigners } from '@origintrail-official/dkg-chain';

interface ExternalAuthorConfig {
  readonly chainConfig?: { readonly authors?: ExternalAuthorSigners };
}

interface TypedDataInput {
  domain: ethers.TypedDataDomain;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
}

/** The external signer for `address`, when it is one of the configured author keys. */
export async function externalAuthorSignerFor(
  config: ExternalAuthorConfig,
  address: string,
): Promise<EvmSigner | undefined> {
  const authors = config.chainConfig?.authors;
  if (authors === undefined || !ethers.isAddress(address)) return undefined;
  return authors.signerFor(address);
}

/** Sign author typed data and return KAv10's compact (r, vs) form. */
export async function signAuthorTypedDataCompact(
  signer: Pick<EvmSigner, 'signTypedData'>,
  typedData: TypedDataInput,
): Promise<{ r: Uint8Array; vs: Uint8Array }> {
  const sig = ethers.Signature.from(
    await signer.signTypedData(typedData.domain, typedData.types, typedData.message),
  );
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

const REGISTRATION_DOMAIN: ethers.TypedDataDomain = { name: 'DKG Agent Registration', version: '1' };
const REGISTRATION_TYPES = {
  AgentRegistration: [
    { name: 'agent', type: 'address' },
    { name: 'name', type: 'string' },
  ],
};

/**
 * Public key of an agent whose key the external signer holds as an author key.
 * With `publicKey` given it is only checked against `address`; otherwise the
 * signer signs an `AgentRegistration(agent, name)` typed-data statement and the
 * public key is recovered from that signature.
 */
export async function externalSignerAgentPublicKey(
  config: ExternalAuthorConfig,
  address: string,
  name: string,
  publicKey?: string,
): Promise<string> {
  if (!ethers.isAddress(address)) throw new Error(`Invalid agent address "${address}"`);
  const agent = ethers.getAddress(address);
  if (config.chainConfig?.authors === undefined) {
    throw new Error(
      'Registering an agent by address requires external author keys (the external signer\'s author connection)',
    );
  }
  const signer = await externalAuthorSignerFor(config, agent);
  if (signer === undefined) {
    throw new Error(`${agent} is not an author key of the external signer (payer accounts cannot be agents)`);
  }
  if (publicKey !== undefined) {
    if (ethers.computeAddress(publicKey) !== agent) {
      throw new Error(`publicKey does not belong to ${agent}`);
    }
    return publicKey;
  }
  const message = { agent, name };
  const signature = await signer.signTypedData(REGISTRATION_DOMAIN, REGISTRATION_TYPES, message);
  const digest = ethers.TypedDataEncoder.hash(REGISTRATION_DOMAIN, REGISTRATION_TYPES, message);
  const recovered = ethers.SigningKey.recoverPublicKey(digest, signature);
  if (ethers.computeAddress(recovered) !== agent) {
    throw new Error(`The external signer did not sign the registration of ${agent} with that key`);
  }
  return recovered;
}
