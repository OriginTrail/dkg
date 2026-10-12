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
import { operationalSigningOf, type AuthorSigner, type ChainAdapter, type ExternalAuthorSigners } from '@origintrail-official/dkg-chain';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { AgentKeyRecord } from './agent-keystore.js';
import { agentKeyWallet, externalAuthorSignerFor } from './author-signer.js';
import type { DKGAgent } from './dkg-agent.js';

/**
 * Whether the node signs through an external signer, as its chain adapter
 * reports: the one classification, whether the agent built the adapter from
 * configured external signers or was given it. Its paying wallets then never
 * author an asset.
 */
export function signsThroughExternalSigner(chain: Pick<ChainAdapter, 'operationalSigning'> | undefined): boolean {
  return operationalSigningOf(chain)?.external === true;
}

const log = new Logger('DKGAgent');

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

/**
 * Register the default agent of a node that signs through an external signer
 * and so holds no operational key to derive one from: the signer's default
 * author, else its first author account, registered by address like any agent
 * the signer holds (the signer signs the registration; the node stores no key).
 * Returns its address, or undefined when the signer serves no author account
 * or the registration fails; the node then has no default agent.
 */
export async function registerExternalDefaultAgent(
  agent: DKGAgent,
  authors: ExternalAuthorSigners | undefined,
  chain: Pick<ChainAdapter, 'operationalSigning'> | undefined,
  name: string,
  framework?: string,
): Promise<string | undefined> {
  if (!signsThroughExternalSigner(chain) || authors === undefined) return undefined;
  const address = authors.defaultAuthor?.address ?? authors.addresses[0];
  if (address === undefined) return undefined;
  const ctx = createOperationContext('system');
  try {
    const record = await agent.registerAgent(name, { address, framework });
    log.info(ctx, `Auto-registered default agent "${record.name}" → ${record.agentAddress}, an author key of the external signer`);
    return record.agentAddress;
  } catch (err) {
    log.warn(ctx, `No default agent: registering author key ${address} of the external signer failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * The default author of the external signer, to become the node's default
 * agent, when the node signs through an external signer and its default agent
 * is another account, for example its former local wallet kept on as a payer.
 * What the node publishes without a selected agent is authored by the default
 * author, so the drafts it opens without one must be the default author's too.
 * A default author that is not an agent yet is registered by address first,
 * under a name no agent of the node has. The other agents stay registered, and
 * what any agent created keeps its author. Undefined (the default agent is
 * kept) without a default author or a default agent, when it already is the
 * default agent, or when its registration fails.
 */
export async function defaultAuthorToAdopt(
  agent: DKGAgent,
  authors: ExternalAuthorSigners | undefined,
  chain: Pick<ChainAdapter, 'operationalSigning'> | undefined,
  name: string,
  framework?: string,
): Promise<string | undefined> {
  const defaultAuthor = authors?.defaultAuthor?.address;
  const previous = agent.getDefaultAgentAddress();
  if (defaultAuthor === undefined || previous === undefined || !signsThroughExternalSigner(chain)) return undefined;
  if (previous.toLowerCase() === defaultAuthor.toLowerCase()) return undefined;
  const ctx = createOperationContext('system');
  try {
    let address = ethers.getAddress(defaultAuthor);
    if (agent.getLocalAgentMode(address) === undefined) {
      const taken = new Set(agent.listLocalAgents().map((record) => record.name));
      address = (await agent.registerAgent(freeDefaultAuthorName(taken, name), { address, framework })).agentAddress;
    }
    log.info(ctx, `Default agent is now the external signer's default author ${address} (was ${previous})`);
    return address;
  } catch (err) {
    log.warn(ctx, `Keeping the default agent: registering default author ${defaultAuthor} of the external signer failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * The name a default author is registered under when the node adopts it: the
 * node's name, else the first of `<name>-default-author`,
 * `<name>-default-author-2`, … that no agent of the node has, so each default
 * author adopted in turn gets its own name and the agents before it keep theirs.
 */
function freeDefaultAuthorName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${name}-default-author` : `${name}-default-author-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
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
