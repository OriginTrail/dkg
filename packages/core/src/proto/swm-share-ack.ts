/**
 * SWM share ack (RFC-003 §4.2, rc.9 PR-D).
 *
 * Single-message protobuf carried by `PROTOCOL_SWM_SHARE_ACK`. The
 * receiver emits one of these to the share author after a
 * gossip-delivered share applies successfully (SharedMemoryHandler
 * returns `applied: true`). The sender's `SwmAckQuorum` accumulates
 * these per `shareOperationId` to compute delivery quorum and decide
 * whether to fire the substrate top-up watchdog.
 *
 * Substrate-delivered shares (`PROTOCOL_SWM_UPDATE`) DO NOT emit a
 * separate SwmShareAck — the substrate response (empty Uint8Array
 * for applied / FANOUT_RESPONSE_REJECTED sentinel for permanent
 * rejection) is itself the ack signal at the substrate layer. This
 * keeps the receiver out of the business of figuring out whether the
 * ack would be redundant with what the substrate already carried.
 *
 * Wire shape kept deliberately minimal — no signature, no
 * timestamp, no nonce. The author peerId is the receiver of the
 * ack message (transport identifies the sender, the sender identifies
 * itself in the body for restart-survival), and the
 * `shareOperationId` is opaque random bytes minted by the original
 * publisher (so it's already unguessable by random peers). Future
 * extensions (PR-G or beyond) MAY add fields without bumping the
 * protocol version as long as the wire bytes stay protobuf-decodable
 * by older senders — that's how protobuf field-number compatibility
 * works.
 *
 * Field semantics:
 *
 *   - `shareOperationId` — the publisher-minted unique ID for the
 *     original share, exactly as it appears in
 *     `WorkspacePublishRequest.shareOperationId` on the gossip path.
 *     The sender's `SwmAckQuorum` keys its pending-share map on this
 *     value; arrival of an ack for an unknown ID is dropped (likely a
 *     stale ack arriving after the share's deadlineHardMs expired and
 *     the record was reaped).
 *   - `ackPeerId` — the libp2p peerId of the receiver as a string
 *     (matches `node.peerId.toString()`). In the rc.9 PR-D
 *     direct-Messenger world this field is REDUNDANT with the
 *     transport-authenticated `fromPeerId` that libp2p hands
 *     `messenger.register()` handlers. The current receiver
 *     (`DKGAgent.handleSwmShareAck`, PR-D codex follow-up #D2)
 *     treats `fromPeerId` as authoritative and DROPS the ack on
 *     any non-empty body/transport mismatch as a likely spoof
 *     attempt (pre-D2 we trusted the body, which let any peer
 *     that learned a `shareOperationId` claim delivery on
 *     someone else's behalf and suppress watchdog top-up for
 *     them). Empty `ackPeerId` is still accepted — it's the
 *     forward-compat slot for a future relayed-ack path where
 *     `fromPeerId` would be a relay node and the body would
 *     carry the original receiver identity (signed with that
 *     receiver's agent key, since at that point the transport
 *     guarantee no longer covers identity end-to-end). That
 *     relay path is NOT supported today; senders SHOULD set
 *     `ackPeerId = receiver.peerId.toString()` for symmetry
 *     with `fromPeerId`, but receivers will reject any other
 *     non-empty value.
 *
 * @internal
 */

import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const SwmShareAckSchema = new Type('SwmShareAck')
  .add(new Field('shareOperationId', 1, 'string'))
  .add(new Field('ackPeerId', 2, 'string'));

export interface SwmShareAckMsg {
  shareOperationId: string;
  ackPeerId: string;
}

export function encodeSwmShareAck(msg: SwmShareAckMsg): Uint8Array {
  return SwmShareAckSchema.encode(
    SwmShareAckSchema.create(msg),
  ).finish();
}

export function decodeSwmShareAck(buf: Uint8Array): SwmShareAckMsg {
  return SwmShareAckSchema.decode(buf) as unknown as SwmShareAckMsg;
}
