# DKG

This context describes the project language for Knowledge Asset publication and operational diagnostics across DKG nodes.

## Language

**Knowledge Asset Publish Lifecycle**:
The end-to-end path that moves a Knowledge Asset from local working memory through shared working memory, peer validation and acknowledgement, verifiable memory, and chain confirmation.
_Avoid_: Publish request, transaction, one-off publish step

**Published KA Sync Lifecycle**:
The catch-up path that lets another node discover, fetch, validate, and materialize an already published Knowledge Asset it missed or only partially received.
This is a separate diagnostic lifecycle from the Knowledge Asset Publish Lifecycle and should not be emitted as `ka_publish_lifecycle` publish logs.
_Avoid_: Generic sync, peer refresh, background catch-up

**Asset UAL**:
The canonical operator-facing identifier for a Knowledge Asset in publish lifecycle logs. It is the single value operators should use to isolate logs for one asset across publisher and receiver nodes.
_Avoid_: Asset URL, asset UIL, reserved UAL, publish operation ID, batch ID

**Publish Lifecycle Log**:
A diagnostic log line tied to one Asset UAL that explains a lifecycle state change, the node role, relevant inputs, relevant outputs, and the failure reason when the step does not complete.
_Avoid_: Generic debug log, raw structured event, trace-only span

**Lifecycle State Change**:
A meaningful transition in the Knowledge Asset Publish Lifecycle, including a step starting, succeeding, failing, being declined, being retried, or reaching quorum.
_Avoid_: Timer tick, verbose attempt detail, implementation trace

**Working Memory**:
The local editable layer where a Knowledge Asset draft is created and written before it is shared or published.
_Avoid_: Draft store, local memory

**Shared Working Memory**:
The replicated pre-publication layer where receiving nodes apply, validate, and acknowledge Knowledge Asset data before publication is finalized.
_Avoid_: Gossip store, replication buffer

**Verifiable Memory**:
The confirmed Knowledge Asset layer populated after successful publication or chain-driven reconciliation.
_Avoid_: Verified memory, final store

**Publishing Node**:
The node that initiates publication of a Knowledge Asset and drives the lifecycle through sharing, acknowledgement collection, chain submission, and confirmation.
_Avoid_: Originator, sender

**Receiving Node**:
A peer node that receives publish lifecycle data, validates or stores it locally, and returns the appropriate acknowledgement or rejection.
_Avoid_: Replica, target, subscriber

**Peer ID**:
The libp2p identity of a node process or network endpoint used for transport, gossip, and direct peer interaction.
_Avoid_: Node ID, operator ID

**Node Identity ID**:
The on-chain DKG node/operator identity used for Storage ACK verification, quorum accounting, and attribution when available.
_Avoid_: Peer ID, wallet address, generic node ID

**ACK**:
A protocol acknowledgement returned by a receiving node for a publish lifecycle step. Use the specific ACK name in logs when the distinction matters.
_Avoid_: STK, generic success

**SWM Share ACK**:
A receiving-node acknowledgement that a shared working memory write was applied locally for the Knowledge Asset.
_Avoid_: Share response, gossip ACK

**Storage ACK**:
A receiving-node acknowledgement that signs the publish commitment after the node validates the relevant shared working memory payload for the Knowledge Asset.
_Avoid_: STK, generic ACK

**Sender Key Package ACK**:
A receiving-node acknowledgement or rejection for Sender Key setup package delivery used by encrypted shared working memory payloads.
_Avoid_: STK, encryption ACK
