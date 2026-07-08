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
