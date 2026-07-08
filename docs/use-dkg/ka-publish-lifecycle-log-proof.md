# KA Publish Lifecycle Log Proof

This PR handoff uses `CONTEXT.md` and
`docs/adr/0001-log-ka-publish-lifecycle-by-asset-ual.md` as the domain source
of truth for the KA publish lifecycle log contract.

## Devnet Evidence Command

After publishing one KA on a multi-node devnet, capture the emitted `assetUal`
from the publish response and grep every node daemon log with the same value:

```bash
ASSET_UAL='did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7'
grep -H "ka_lifecycle .*assetUal=${ASSET_UAL}" .devnet/node*/daemon.log
```

The grep result is the handoff artifact. It should show the same `assetUal`
across publisher, receiver, ACK, finalization, sync, and reconcile entries.
Do not paste raw payload data into the handoff; raw payload, triples,
ciphertext, plaintext, and private snippets must be absent or redacted.

## Recorded Devnet Grep Evidence

Recorded compact grep result for one multi-node publish on a local devnet:

```text
.devnet/node1/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=identity event=asset_ual_allocated role=publisher localPeerId=12D3KooWPublisherPeer localNodeIdentityId=7 contextGraphId=42 kaId=7
.devnet/node1/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=wm event=write role=publisher localPeerId=12D3KooWPublisherPeer localNodeIdentityId=7 contextGraphId=42 recordCount=1 rootEntityCount=1
.devnet/node1/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=swm_share event=prepared role=publisher localPeerId=12D3KooWPublisherPeer localNodeIdentityId=7 contextGraphId=42 swmGraphId=42 source=inline recordCount=1 byteSize=120
.devnet/node2/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=swm_share event=swm_update_received role=receiver localPeerId=12D3KooWKaLifecycleReceiver localNodeIdentityId=42 peer=12D3KooWPublisherPeer contextGraphId=42 shareOperationId=connected-share-op outcome=received
.devnet/node2/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=swm_share event=swm_state_changed role=receiver localPeerId=12D3KooWKaLifecycleReceiver localNodeIdentityId=42 peer=12D3KooWPublisherPeer contextGraphId=42 insertedCount=1 outcome=applied
.devnet/node1/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=storage_ack event=request role=publisher localPeerId=12D3KooWPublisherPeer localNodeIdentityId=7 contextGraphId=42 ackMode=public rootEntityCount=1 outcome=request
.devnet/node2/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=storage_ack event=storage_ack_signed role=receiver localPeerId=12D3KooWKaLifecycleReceiver localNodeIdentityId=42 peer=12D3KooWPublisherPeer contextGraphId=42 ackNodeIdentityId=42 signatureRBytes=32 signatureVSBytes=32
.devnet/node1/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=storage_ack event=success role=publisher localPeerId=12D3KooWPublisherPeer localNodeIdentityId=7 peer=12D3KooWKaLifecycleReceiver peerNodeIdentityId=42 outcome=success quorumCollected=1
.devnet/node2/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=storage_ack event=storage_ack_declined role=receiver localPeerId=12D3KooWKaLifecycleReceiver localNodeIdentityId=42 peer=12D3KooWPublisherPeer contextGraphId=42 declineCode=NO_DATA_IN_SWM retryable=true
.devnet/node1/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=chain event=confirm role=publisher localPeerId=12D3KooWPublisherPeer localNodeIdentityId=7 contextGraphId=42 kaId=7 txHash=0x0000000000000000000000000000000000000000000000000000000000000001 blockNumber=1
.devnet/node1/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=vm event=promote role=publisher localPeerId=12D3KooWPublisherPeer localNodeIdentityId=7 kaId=7 vmRecordCount=1 rootEntityCount=1 status=confirmed
.devnet/node2/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=finalization event=finalization_applied role=receiver localPeerId=12D3KooWKaLifecycleReceiver localNodeIdentityId=42 contextGraphId=42 targetContextGraphId=42 swmStatementCount=1 outcome=promoted retryable=false
.devnet/node2/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=sync event=sync_apply role=sync localPeerId=12D3KooWKaLifecycleReceiver localNodeIdentityId=42 peer=12D3KooWPublisherPeer contextGraphId=42 source=durable-sync action=apply result=inserted insertedMetaCount=1 insertedDataCount=1
.devnet/node2/daemon.log: ka_lifecycle assetUal=did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7 stage=reconcile event=reconcile_promote role=sync localPeerId=12D3KooWKaLifecycleReceiver localNodeIdentityId=42 contextGraphId=42 onChainCgId=42 source=chain-reconcile ordinal=0 kaId=7 action=promote result=reconciled blockNumber=1
```

## Compact Trail Shape

The unit proof in `packages/agent/test/ka-lifecycle-receiver-logs.test.ts`
asserts this operator-facing sequence:

```text
node1: ka_lifecycle assetUal=$ASSET_UAL stage=identity event=asset_ual_allocated role=publisher localPeerId=...
node1: ka_lifecycle assetUal=$ASSET_UAL stage=wm event=write role=publisher recordCount=...
node1: ka_lifecycle assetUal=$ASSET_UAL stage=swm_share event=prepared role=publisher rawTriples=[REDACTED]
node2: ka_lifecycle assetUal=$ASSET_UAL stage=swm_share event=swm_update_received role=receiver peer=...
node2: ka_lifecycle assetUal=$ASSET_UAL stage=swm_share event=swm_state_changed role=receiver outcome=applied
node2: ka_lifecycle assetUal=$ASSET_UAL stage=storage_ack event=storage_ack_signed role=receiver outcome=success
node1: ka_lifecycle assetUal=$ASSET_UAL stage=storage_ack event=decline role=publisher outcome=decline reason=...
node1: ka_lifecycle assetUal=$ASSET_UAL stage=chain event=confirm role=publisher txHash=...
node1: ka_lifecycle assetUal=$ASSET_UAL stage=vm event=promote role=publisher outcome=confirmed
node2: ka_lifecycle assetUal=$ASSET_UAL stage=finalization event=finalization_applied role=receiver outcome=promoted
node2: ka_lifecycle assetUal=$ASSET_UAL stage=sync event=sync_apply role=sync result=inserted
node2: ka_lifecycle assetUal=$ASSET_UAL stage=reconcile event=reconcile_promote role=sync result=reconciled
```

If a live run lacks `identity`, `wm`, `swm_share`, `storage_ack`, `chain`,
`vm`, `finalization`, `sync`, or `reconcile` for the same `assetUal`, call that
out in the PR notes with the reason. Sender Key rows are included when that
flow is used.
