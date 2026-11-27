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
import { RemoteSignerError, operationalSigningOf, type AuthorSigner, type ChainAdapter, type ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import { GOSSIP_ENVELOPE_FRESHNESS_MS } from '@origintrail-official/dkg-core';
import type { AgentKeyRecord } from './agent-keystore.js';
import { agentKeyWallet, externalAuthorSignerFor } from './author-signer.js';

/**
 * Whether the node signs through an external signer, as its chain adapter
 * reports: the one classification, whether the agent built the adapter from
 * configured external signers or was given it. Its paying wallets then never
 * author an asset.
 */
export function signsThroughExternalSigner(chain: Pick<ChainAdapter, 'operationalSigning'> | undefined): boolean {
  return operationalSigningOf(chain)?.external === true;
}

interface TypedDataInput {
  domain: ethers.TypedDataDomain;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
}

/**
 * An allowed agent's capability to sign SWM gossip envelopes: the EIP-191
 * signature over a framed gossip signing payload, made with the agent's key
 * held on the node or, over exactly the same bytes, by the external signer
 * that holds its author key (`eth_sign`, or `personal_sign`), so receivers
 * verify both alike.
 */
export interface WorkspaceGossipSigner {
  readonly agentAddress: string;
  signMessage(message: Uint8Array): Promise<string>;
}

/**
 * The gossip signer of an agent whose key is held on the node: the agent
 * signer's wallet for that key, built once. Which agent signs is the gossip
 * protocol's choice; its external counterpart is chosen below in one lookup.
 */
export function localGossipSigner(agentAddress: string, privateKey: string): WorkspaceGossipSigner {
  const wallet = agentKeyWallet(privateKey);
  return { agentAddress, signMessage: (message) => wallet.signMessage(message) };
}

/**
 * How long the signature of a gossip envelope may take after the timestamp it
 * signs. Receivers refuse an envelope whose timestamp is more than
 * `GOSSIP_ENVELOPE_FRESHNESS_MS` (300 s) off their clock: the curator that
 * confirms a write before it commits, and the peers it fans out to after. Half
 * of that window (150 s) for the signature leaves the other half for the
 * curator's applied-ack (5 s by default), the commit, the fan-out and the clock
 * skew between nodes.
 */
export const GOSSIP_ENVELOPE_SIGNING_BUDGET_MS = GOSSIP_ENVELOPE_FRESHNESS_MS / 2;

/**
 * `signer`'s signature over the signing payload of a gossip envelope stamped
 * `timestamp`, asked for once and awaited at most until
 * {@link GOSSIP_ENVELOPE_SIGNING_BUDGET_MS} after that timestamp; a later one
 * is refused as `REMOTE_SIGNER_TIMEOUT`. A share prepares its envelope before it
 * commits, so the write then fails with nothing stored instead of committing an
 * envelope its peers would refuse; after a commit (a promote's fan-out) only the
 * fan-out fails.
 */
export async function signGossipEnvelopeInTime(
  signer: WorkspaceGossipSigner,
  signingPayload: Uint8Array,
  timestamp: string,
): Promise<string> {
  const deadline = Date.parse(timestamp) + GOSSIP_ENVELOPE_SIGNING_BUDGET_MS;
  const late = () => new RemoteSignerError(
    'REMOTE_SIGNER_TIMEOUT',
    `The signature of a gossip envelope took longer than ${GOSSIP_ENVELOPE_SIGNING_BUDGET_MS / 1000} s; ` +
      `peers refuse envelopes more than ${GOSSIP_ENVELOPE_FRESHNESS_MS / 1000} s old`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const signature = await Promise.race([
      signer.signMessage(signingPayload),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(late()), Math.max(0, deadline - Date.now()));
      }),
    ]);
    if (Date.now() > deadline) throw late();
    return signature;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The gossip signer of the first of `agents` whose author key the external
 * signer holds, chosen in one selection over the author accounts: of the agents
 * in `allowed` when the graph has a signing roster, else of every agent, with
 * `preferred` (the default agent) tried first. A payer is never selected.
 */
export async function externalAuthorGossipSigner(
  authors: ExternalAuthorSigners | undefined,
  agents: Iterable<AgentKeyRecord>,
  selection: { readonly allowed?: ReadonlySet<string>; readonly preferred?: string },
): Promise<WorkspaceGossipSigner | undefined> {
  if (authors === undefined) return undefined;
  const { allowed, preferred } = selection;
  const eligible = [...agents]
    .map((record) => record.agentAddress)
    .filter((address) => ethers.isAddress(address) && (allowed?.has(address.toLowerCase()) ?? true));
  const isPreferred = (address: string) => address.toLowerCase() === preferred?.toLowerCase();
  const candidates = [...eligible.filter(isPreferred), ...eligible.filter((address) => !isPreferred(address))];
  const found = await authors.firstSignerOf(candidates);
  if (found === undefined) return undefined;
  const { address, signer } = found;
  return { agentAddress: address, signMessage: (message) => signer.signMessage(message) };
}

/** Sign author typed data and return KAv10's compact (r, vs) form. */
export async function signAuthorTypedDataCompact(
  signer: Pick<AuthorSigner, 'signTypedData'>,
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
  authors: ExternalAuthorSigners | undefined,
  address: string,
  name: string,
  publicKey?: string,
): Promise<string> {
  if (!ethers.isAddress(address)) throw new Error(`Invalid agent address "${address}"`);
  const agent = ethers.getAddress(address);
  if (authors === undefined) {
    throw new Error(
      'Registering an agent by address requires external author keys (the external signer\'s author connection)',
    );
  }
  const signer = await externalAuthorSignerFor(authors, agent);
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
