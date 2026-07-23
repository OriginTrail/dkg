# RFC-64 Gate 1 — two-process public author-catalog demo

Demonstrates the Gate 1 wiring across **two real `DKGAgent` OS processes**: an
author announces + serves a signed empty author-catalog genesis head, and a
receiver's *wired* `onCatalogHeadAvailable` + scheduler fetch it by exact
digest, re-verify it, and durably stage it into its control-object store.

Everything runs through the wired agent API (`DKGAgent.start()` constructs the
service on the production router); no transport is hand-built.

## Run

```sh
# Build the agent package + its workspace deps to dist first:
pnpm turbo run build --filter=@origintrail-official/dkg-agent...

node devnet/rfc64-gate1-public-catalog/run.mjs
```

The orchestrator (`run.mjs`) spawns `agent-process.mjs` twice (author +
receiver), connects them over libp2p, drives publish → announce → fetch →
re-verify → durable stage, and writes deterministic evidence to
`artifacts/gate1-result.json`. Exit code 0 == all checks `PASS`.

## What it proves (and what it deliberately does not)

- Author + receiver each start the catalog service on their production router.
- The receiver independently accepts the same open (`accessPolicy=0`) policy and
  computes the identical `policyDigest` — never derived from the wire hint.
- The announcement is acknowledged over the production router; the receiver
  fetches the exact head, the transport re-verifies it, and it is durably staged.
- The receiver reads the exact head back from its control-object store.
- **No activation:** the CG is not activated as queryable knowledge — Gate 1
  stages the head and stops (no candidate admission, no KA/SWM/VM).
