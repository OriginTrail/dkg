import { peerIdFromString } from '@libp2p/peer-id';
import {
  parseDeterministicKnowledgeAssetUal,
  startRequestAbortLifecycle,
} from '@origintrail-official/dkg-core';
import { RequestOwnedAccessClient, accessError } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from './dkg-agent.js';
import { DKGAgentBase } from './dkg-agent-base.js';

export interface PrivateAccessRequest {
  publisherPeerId: string;
  kaUal: string;
}

/** Peer-root self-consistency never authenticates a chain commitment. */
export type PrivateAccessResponse =
  | { granted: true; quads: Quad[]; storedInGraph: false; privateMerkleRoot: string;
      verification: { kind: 'peer-root-self-check'; matches: true; chainAnchored: false } }
  | { granted: false; quads: []; storedInGraph: false;
      verification: { kind: 'not-checked'; matches: false; chainAnchored: false } };

type Owner = Pick<DKGAgent, 'messenger' | 'wallet' | 'peerId' | 'node'>;
const running = new WeakSet<Owner>();
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUADS = 10_000;

/** Manual bounded read; peer policy is enforced by the publisher's AccessHandler. */
export async function requestOwnedPrivateAccess(
  owner: Owner,
  input: PrivateAccessRequest,
  options: { signal?: AbortSignal } = {},
): Promise<PrivateAccessResponse> {
  let publisherPeerId: string;
  let kaUal: string;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'publisherPeerId' && key !== 'kaUal')
      || typeof input.publisherPeerId !== 'string' || input.publisherPeerId.length > 128
      || typeof input.kaUal !== 'string' || input.kaUal.length > 512) throw new Error();
    publisherPeerId = peerIdFromString(input.publisherPeerId).toString();
    kaUal = parseDeterministicKnowledgeAssetUal(input.kaUal).ual;
  } catch {
    throw accessError('ACCESS_INVALID_REQUEST', 'A valid publisher peer ID and current KA UAL are required');
  }
  if (running.has(owner)) throw accessError('ACCESS_BUSY', 'A private access request is already running');
  const lifecycle = startRequestAbortLifecycle(TIMEOUT_MS, [options.signal, owner.node.stopSignal]);
  running.add(owner);
  try {
    const client = new RequestOwnedAccessClient(owner.messenger, owner.wallet.keypair, owner.peerId);
    const result = await client.requestAccess(publisherPeerId, kaUal, undefined, {
      signal: lifecycle.signal, timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES, maxQuads: MAX_QUADS,
    });
    if (!result.granted) return {
      granted: false, quads: [], storedInGraph: false,
      verification: { kind: 'not-checked', matches: false, chainAnchored: false },
    };
    if (!result.verified) throw accessError('ACCESS_INTEGRITY_FAILED', 'The peer payload does not match its supplied root');
    return {
      granted: true, quads: result.quads, storedInGraph: false,
      privateMerkleRoot: `0x${Buffer.from(result.privateMerkleRoot!).toString('hex')}`,
      verification: { kind: 'peer-root-self-check', matches: true, chainAnchored: false },
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (lifecycle.deadline.aborted) throw accessError('ACCESS_TIMEOUT', 'Private access timed out');
    if (lifecycle.signal.aborted) throw accessError('ACCESS_UNAVAILABLE', 'Node is stopping');
    throw error;
  } finally {
    lifecycle.release();
    running.delete(owner);
  }
}

export class PrivateAccessMethods extends DKGAgentBase {
  /** Explicit private read; a peer-root self-check is not chain authentication. */
  async requestPrivateAccess(this: DKGAgent, input: PrivateAccessRequest, options: { signal?: AbortSignal } = {}) {
    if (!this.started) throw accessError('ACCESS_UNAVAILABLE', 'Node is not started');
    return requestOwnedPrivateAccess(this, input, options);
  }
}
