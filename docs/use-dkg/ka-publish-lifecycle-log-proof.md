# KA Publish Lifecycle Log Proof

This PR handoff uses `CONTEXT.md` and
`docs/adr/0001-log-ka-publish-lifecycle-by-asset-ual.md` as the domain source
of truth for the KA publish lifecycle log contract.

## Repeatable Devnet Artifact

Generate proof from the branch under test instead of pasting a representative
sample. Start a multi-node devnet, build the runtime packages, then run:

```bash
./scripts/devnet.sh start 6
pnpm run build
scripts/devnet-ka-lifecycle-log-proof.sh
```

The script publishes one KA through `scripts/devnet-test-publish.sh`, extracts
the confirmed `assetUal`, and writes an artifact directory under:

```text
.devnet/ka-lifecycle-log-proof/<timestamp>/
```

Attach these files to the PR handoff or reviewer reply:

- `metadata.txt`: git SHA, branch, devnet directory, node count, publisher
  node, `assetUal`, `batchId`, `txHash`, required lifecycle tokens, and the
  exact grep command.
- `publish.txt`: full output from the publish command.
- `grep.txt`: every new daemon log row matching the same `assetUal`.

`grep.txt` is the validation evidence. It must show the same `assetUal` across
publisher, receiver, ACK, finalization, sync, and reconcile rows. The script
fails if any required lifecycle token is missing.

Do not paste raw payload data into the handoff. Raw payload, triples,
ciphertext, plaintext, and private snippets must be absent or redacted.

## Manual Grep

If you need to inspect a run by hand, capture the emitted `assetUal` from the
publisher daemon log and grep every node daemon log with the same value:

```bash
ASSET_UAL='did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7'
grep -H "ka_lifecycle .*assetUal=${ASSET_UAL}" .devnet/node*/daemon.log
```

For a PR handoff, include enough run metadata for another engineer to repeat
the check:

- git commit SHA and branch under test
- devnet size and node roles
- publish command or API route used to create the KA
- emitted `assetUal`
- exact grep command and full grep output, with only sensitive payload values
  redacted

## Compact Trail Shape

The unit proof in `packages/agent/test/ka-lifecycle-proof.test.ts` plus the
split lifecycle suites under `packages/agent/test/ka-lifecycle-*.test.ts`
assert this operator-facing sequence:

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
