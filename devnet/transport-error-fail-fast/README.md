# transport-error-fail-fast - devnet regression

Read-only live devnet coverage for the typed transport-error classification in
`ProtocolRouter.send()` (`packages/core/src/transport-error.ts`).

## What it proves

`send()` used to retry a peer that refused the protocol ("Protocol selection
failed - could not negotiate ...") three times, with 500 ms + 1000 ms of
backoff, because the substring classifier listed those words as recoverable.
The suite starts its own in-process `ProtocolRouter` (an ephemeral libp2p node
bootstrapped to every devnet node) and checks, against the real daemons, that:

- a devnet node that does not handle a protocol fails the send **fast**: one
  dial, well under the first backoff step, with libp2p's typed
  `UnsupportedProtocolError`;
- an **edge** node, the devnet's natural non-negotiating peer for StorageACK
  (only cores register that handler), fails the same way, and
  `isProtocolUnsupportedError` still matches it. That predicate is what the
  publisher's ACK collector counts as `protocol_unsupported`, i.e.
  peer-unreachable against the quorum;
- a **core** that does speak StorageACK answers `probeProtocol` with
  `supported` and is never classified as refusing.

## Run

```bash
pnpm run build
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:transport-error-fail-fast
```

The suite does not publish, restart nodes, or mutate chain state. The only
entity it creates is its own ephemeral libp2p peer. It imports the router from
`packages/core/src` (not `dist`), so it always exercises the checked-out code.

The quorum tally itself is pinned by `packages/publisher/test/ack-collector.test.ts`
and `ack-metrics.test.ts`; `pnpm test:devnet:mixed-version` covers a real
publish reaching ACK quorum across the cluster.
