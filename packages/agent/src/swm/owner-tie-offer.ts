// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's node of a public graph offers the Cores it is connected to the
 * owner-peer tie (`core-hosted-owner-peer-tie.ts`): one envelope signed by the
 * wallet the graph id names, around a share request that names this node as
 * its publisher and carries no content.
 *
 * A Core asks the owner's node for a new graph's definition at once only after
 * a share that the owner's wallet signed tied that node to the graph. The
 * owner's own shares do not always do that before its first StorageACK:
 *  - a share into the root of a graph whose catalog owns the root goes to no
 *    follower and no Core; only the catalog's head is announced;
 *  - the node signs shares with its default agent, which need not be the
 *    wallet the graph id names.
 * So the owner's node offers the tie when it shares into the graph and before
 * it asks for StorageACKs: to each connected Core at most once per
 * {@link OWNER_TIE_OFFER_INTERVAL_MS}, which is shorter than the time a Core
 * keeps the tie of a graph it does not host yet, signed with the key of the
 * graph id's wallet (an agent key, the external author signer, or one of the
 * chain adapter's operational wallets), best effort: one send each, no outbox,
 * no retry. A node that holds no key of that wallet offers nothing, and
 * neither does one whose own subscription record of the graph carries no
 * on-chain id: a Core hosts a graph through the StorageACK gate only once it
 * is registered, so an unregistered graph's tie would serve no Core. A Core
 * reads the tie from the envelope before it handles it as a share, and then
 * refuses it as one: it carries no content and names no content scope.
 */

import { encodeWorkspacePublishRequest, GOSSIP_ENVELOPE_FRESHNESS_MS } from '@origintrail-official/dkg-core';
import { rememberBounded } from '../bounded-map.js';
import { isCanonicalAuthoritativeContextGraphId } from '../context-graph-binding-state.js';
import { rfc64UnregisteredAuthorityOwnerV1 } from '../rfc64/unregistered-authority-transport-v1.js';

/** How often one Core is offered one graph's tie at most; within an envelope's freshness window. */
export const OWNER_TIE_OFFER_INTERVAL_MS = (GOSSIP_ENVELOPE_FRESHNESS_MS * 4) / 5;
/** (graph, Core) offers remembered at most. */
export const OWNER_TIE_OFFER_MEMORY_MAX = 1_024;

/** What the offers use of the agent. */
export interface OwnerTieOfferPorts {
  /** Whether this node holds a key of `wallet` (lower case) to sign with; answered without signing. */
  holdsKeyOf(wallet: string): boolean;
  /** The on-chain id this node's own subscription record of the graph carries, if any; read locally, never from the chain. */
  localOnChainId(contextGraphId: string): string | undefined;
  /** Whether the graph is public; false when its policy cannot be read. */
  isPublic(contextGraphId: string): Promise<boolean>;
  /** The connected Cores this node can send to now. */
  cores(): Promise<readonly string[]>;
  /** The envelope around `request` that `wallet` signs; rejects when no key of it signs. */
  sign(contextGraphId: string, wallet: string, request: Uint8Array): Promise<Uint8Array>;
  /** One send; rejects on a transport failure. */
  send(peerId: string, wire: Uint8Array): Promise<void>;
  selfPeerId(): string;
  logDebug(message: string): void;
}

/** The share request of an offer: this node as publisher, no content, no content scope. */
export function ownerTieOfferRequest(contextGraphId: string, publisherPeerId: string, now: number): Uint8Array {
  return encodeWorkspacePublishRequest({
    contextGraphId,
    nquads: new Uint8Array(),
    manifest: [],
    publisherPeerId,
    shareOperationId: `owner-tie-${now}`,
    timestampMs: now,
  });
}

/** One agent's offers, each (graph, Core) at most once per {@link OWNER_TIE_OFFER_INTERVAL_MS}. */
export class OwnerTieOffers {
  readonly #ports: OwnerTieOfferPorts;
  readonly #now: () => number;
  readonly #offeredAt = new Map<string, number>();

  constructor(ports: OwnerTieOfferPorts, now: () => number = Date.now) {
    this.#ports = ports;
    this.#now = now;
  }

  /**
   * Offer the graph's tie to the connected Cores not offered it lately, when
   * its id names a wallet this node holds a key of, this node's record of it
   * carries an on-chain id, and the graph is public. Resolves with the Cores
   * it went to; never throws.
   */
  async offer(contextGraphId: string): Promise<readonly string[]> {
    try {
      const wallet = rfc64UnregisteredAuthorityOwnerV1(contextGraphId);
      if (wallet === null || !this.#ports.holdsKeyOf(wallet)) return [];
      if (!isCanonicalAuthoritativeContextGraphId(this.#ports.localOnChainId(contextGraphId))) return [];
      const now = this.#now();
      const due = (await this.#ports.cores()).filter((peerId) => {
        const at = this.#offeredAt.get(`${contextGraphId}\0${peerId}`);
        return at === undefined || now - at >= OWNER_TIE_OFFER_INTERVAL_MS;
      });
      if (due.length === 0 || !(await this.#ports.isPublic(contextGraphId))) return [];
      // Marked before the signature: a failed one is not tried again before the interval ends.
      for (const peerId of due) rememberBounded(this.#offeredAt, `${contextGraphId}\0${peerId}`, now, OWNER_TIE_OFFER_MEMORY_MAX);
      const wire = await this.#ports.sign(contextGraphId, wallet, ownerTieOfferRequest(contextGraphId, this.#ports.selfPeerId(), now));
      await Promise.all(due.map((peerId) => this.#ports.send(peerId, wire).catch((error: unknown) => {
        this.#ports.logDebug(`Owner tie offer for "${contextGraphId}" to ${peerId.slice(-8)} failed: ${messageOf(error)}`);
      })));
      return due;
    } catch (error) {
      this.#ports.logDebug(`No owner tie offer for "${contextGraphId}": ${messageOf(error)}`);
      return [];
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const offersByAgent = new WeakMap<object, OwnerTieOffers>();

/** The agent's offers, made on first use with the ports `create` builds. */
export function ownerTieOffersOf(agent: object, create: () => OwnerTieOfferPorts): OwnerTieOffers {
  let offers = offersByAgent.get(agent);
  if (offers === undefined) {
    offers = new OwnerTieOffers(create());
    offersByAgent.set(agent, offers);
  }
  return offers;
}
