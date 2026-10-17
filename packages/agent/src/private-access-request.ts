import { peerIdFromString } from '@libp2p/peer-id';
import {
  parseDeterministicKnowledgeAssetUal,
  resolveWithinAbort,
  startRequestAbortLifecycle,
} from '@origintrail-official/dkg-core';
import { AccessClient } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from './dkg-agent.js';

export interface PrivateAccessRequest {
  publisherPeerId: string;
  kaUal: string;
}

export interface PrivateAccessResponse {
  granted: boolean;
  quads: Quad[];
  /** The request never inserts returned data into a local RDF graph. */
  storedInGraph: false;
  /** A peer's supplied root is not an independently authenticated chain commitment. */
  verification: { kind: 'peer-root-self-check' | 'not-checked'; matches: boolean; chainAnchored: false };
  privateMerkleRoot?: string;
}

type Owner = Pick<DKGAgent, 'messenger' | 'wallet' | 'peerId' | 'node'>;
const running = new WeakSet<Owner>();
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUADS = 10_000;

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

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
    throw failure('ACCESS_INVALID_REQUEST', 'A valid publisher peer ID and current KA UAL are required');
  }
  if (running.has(owner)) throw failure('ACCESS_BUSY', 'A private access request is already running');
  const lifecycle = startRequestAbortLifecycle(TIMEOUT_MS, [options.signal, owner.node.stopSignal]);
  running.add(owner);
  try {
    const client = new AccessClient({
      sendReliable: async (peer, protocol, payload, sendOptions) => {
        // Preserve reliable wire framing, but never enqueue a read after its caller ends.
        const result = await owner.messenger.sendRequestOwned(peer, protocol, payload, { ...sendOptions, recoverPeerAfterFailure: false });
        if (!result.delivered) throw failure('ACCESS_UNAVAILABLE', 'Private access transport is busy');
        return result;
      },
    }, owner.wallet.keypair, owner.peerId);
    const result = await resolveWithinAbort(() => client.requestAccess(publisherPeerId, kaUal, undefined, {
      signal: lifecycle.signal, timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES, maxQuads: MAX_QUADS,
    }), lifecycle.signal);
    lifecycle.signal.throwIfAborted();
    if (!result) throw failure('ACCESS_UNAVAILABLE', 'Private access did not complete');
    if (!result.granted) return {
      granted: false, quads: [], storedInGraph: false,
      verification: { kind: 'not-checked', matches: false, chainAnchored: false },
    };
    if (!result.verified) throw failure('ACCESS_INTEGRITY_FAILED', 'The peer payload does not match its supplied root');
    return {
      granted: true, quads: result.quads, storedInGraph: false,
      privateMerkleRoot: `0x${Buffer.from(result.privateMerkleRoot!).toString('hex')}`,
      verification: { kind: 'peer-root-self-check', matches: true, chainAnchored: false },
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (lifecycle.deadline.aborted) throw failure('ACCESS_TIMEOUT', 'Private access timed out');
    if (lifecycle.signal.aborted) throw failure('ACCESS_UNAVAILABLE', 'Node is stopping');
    throw error;
  } finally {
    lifecycle.release();
    running.delete(owner);
  }
}
