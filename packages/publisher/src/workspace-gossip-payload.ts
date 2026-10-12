import { tryCanonicalPeerIdString } from '@origintrail-official/dkg-core';
import type { WorkspaceAgentRecipientFanoutSnapshot } from './workspace-agent-recipients.js';

/** Network-ready workspace bytes and the provenance used to plan fan-out. */
export interface EncodedWorkspaceGossipPayload {
  readonly message: Uint8Array;
  readonly fanout:
    | {
        /** Resolve current membership at the publish boundary (legacy/public path). */
        readonly kind: 'resolve-current';
      }
    | {
        /** Reuse the exact transport projection captured with these bytes. */
        readonly kind: 'captured';
        readonly snapshot: WorkspaceAgentRecipientFanoutSnapshot;
      };
  /**
   * The network form of `message` (its signed gossip envelope) when the write
   * prepared it before committing: fan-out sends these bytes as they are.
   */
  readonly envelope?: Uint8Array;
}

/**
 * Prepares the network form of a share's gossip message before the write
 * commits, for example by signing its envelope, and returns only those bytes.
 * The publisher calls it once the message is built and size-checked, before
 * the curator confirmation and before anything is stored, so a rejection
 * aborts the write with nothing stored. The publisher attaches the bytes to
 * the payload it built ({@link withWorkspaceGossipEnvelope}); that one payload
 * goes to the confirmation and into the write result.
 */
export type PrepareWorkspaceGossip = (message: Uint8Array) => Promise<Uint8Array>;

/** `payload` with the envelope prepared for its message; its message and fan-out provenance are kept. */
export function withWorkspaceGossipEnvelope(
  payload: EncodedWorkspaceGossipPayload,
  envelope: Uint8Array,
): EncodedWorkspaceGossipPayload {
  return Object.freeze({ message: payload.message, fanout: payload.fanout, envelope });
}

export function createResolveCurrentWorkspaceGossipPayload(
  message: Uint8Array,
): EncodedWorkspaceGossipPayload {
  return Object.freeze({
    message,
    fanout: Object.freeze({ kind: 'resolve-current' as const }),
  });
}

export function createCapturedWorkspaceGossipPayload(
  message: Uint8Array,
  snapshot: WorkspaceAgentRecipientFanoutSnapshot,
): EncodedWorkspaceGossipPayload {
  const canonicalMembers = new Set<string>();
  for (const member of snapshot.members) {
    const canonicalMember = tryCanonicalPeerIdString(member);
    if (!canonicalMember) {
      throw new TypeError(`Captured workspace fan-out snapshot contains an invalid peer ID: "${member}"`);
    }
    canonicalMembers.add(canonicalMember);
  }
  const ownedSnapshot: WorkspaceAgentRecipientFanoutSnapshot = Object.freeze({
    source: 'agent-roster',
    members: Object.freeze([...canonicalMembers]),
    complete: snapshot.complete,
  });
  return Object.freeze({
    message,
    fanout: Object.freeze({ kind: 'captured' as const, snapshot: ownedSnapshot }),
  });
}

/** Validate an encoded workspace payload at the cross-package publish seam. */
export function parseEncodedWorkspaceGossipPayload(
  value: unknown,
): EncodedWorkspaceGossipPayload {
  const payload = parseFanoutPayload(value);
  const envelope = (value as Record<string, unknown>)['envelope'];
  if (envelope === undefined) return payload;
  if (!(envelope instanceof Uint8Array)) {
    throw new TypeError('publishWorkspaceGossip requires a prepared envelope to be bytes');
  }
  return withWorkspaceGossipEnvelope(payload, envelope);
}

function parseFanoutPayload(value: unknown): EncodedWorkspaceGossipPayload {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('publishWorkspaceGossip requires encoded bytes with fan-out provenance');
  }
  const payload = value as Record<string, unknown>;
  if (!(payload['message'] instanceof Uint8Array) || typeof payload['fanout'] !== 'object' || payload['fanout'] === null) {
    throw new TypeError('publishWorkspaceGossip requires encoded bytes with fan-out provenance');
  }
  const fanout = payload['fanout'] as Record<string, unknown>;
  if (fanout['kind'] === 'resolve-current') {
    return createResolveCurrentWorkspaceGossipPayload(payload['message'] as Uint8Array);
  }
  const snapshot = fanout['snapshot'] as Record<string, unknown> | undefined;
  if (
    fanout['kind'] !== 'captured'
    || snapshot?.['source'] !== 'agent-roster'
    || !Array.isArray(snapshot['members'])
    || !snapshot['members'].every((peerId) => typeof peerId === 'string')
    || typeof snapshot['complete'] !== 'boolean'
  ) {
    throw new TypeError('publishWorkspaceGossip requires a complete captured fan-out snapshot');
  }
  return createCapturedWorkspaceGossipPayload(
    payload['message'] as Uint8Array,
    {
      source: 'agent-roster',
      members: snapshot['members'] as string[],
      complete: snapshot['complete'] as boolean,
    },
  );
}
