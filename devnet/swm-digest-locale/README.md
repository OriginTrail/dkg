# swm-digest-locale - devnet regression

Real nodes on different host locales exchange Shared Working Memory whose
snapshot digest used to depend on the host collation.

## What it proves

The digest of a Shared-Working-Memory public snapshot names its file on disk and
is recomputed against a peer-advertised or persisted digest at many sites. It
was sorted with the process default collator, so nodes on different `LANG` /
`LC_ALL` disagreed on byte-identical quads. The change accepts every digest form
when verifying and keeps writing the legacy digest until an operator sets
`DKG_SWM_DIGEST_ORDERING=code-unit`.

The suite restarts nodes with a per-node environment (`DEVNET_NODE_ENV_<N>`,
read by `scripts/devnet.sh` on every launch) and asserts, through the daemon API,
the node logs and the snapshot files:

1. Node 5 is a da-DK host, everything else en-US, gate off. An en-US node
   originates a share; the da-DK edge, joining afterwards, catches it up (its
   own digest of the same quads is different) and logs no digest failure.
2. Without the gate, a da-DK originator records a different digest for the same
   kind of content: the drift.
3. With the gate on, identical content written by a da-DK originator and an
   en-US originator has the same digest and snapshot file name; a late da-DK
   edge (gate on) and a late en-US edge (gate off) both sync it.
4. What was persisted before the flip is still there afterwards.

The rows are chosen so their canonical order really differs between the en-US,
da-DK and code-unit collations (`aa` sorts after `z` in da-DK).

## Run

```bash
pnpm run build && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:swm-digest-locale
```

About 5 minutes. Only self-created context graphs are written; every node is
restarted with the default environment at the start and again at the end.
Registering a graph mines ten blocks so a freshly restarted node sees the
registration as confirmed on an otherwise idle Hardhat chain.
