# RFC-64 private catalog Releases 1-3 gate

This gate validates private RFC-64 recovery across four real `DKGAgent` OS
processes. It uses the production libp2p router and private V2 catalog
protocols. Every process has a persistent Oxigraph graph store and the normal
durable RFC-64 control-object, KA-bundle, and inventory stores.

The topology is:

- one private CG owner and complete provider;
- one authorized receiver that becomes the second complete provider;
- one authorized receiver whose finalized VM baseline is populated by a real
  catalog sync before the later SWM generation;
- one node that is not in the roster.

The test publishes the two assets as a finalized version-1 baseline, populates
the provider and receiver through authorized production syncs, then publishes
the version-2 SWM generation. It proves:

- the first receiver gets the exact signed baseline catalog and finalized VM
  through the second provider, rather than through a test-only store seed;
- the second provider adopts the later catalog head with exact SWM v2 and VM
  v1 contents;
- the owner process exits and its listener closes before the receiver restarts;
  the second provider stays dialable with the exact head, and the receiver gets
  the same exact state only from that provider;
- the node outside the roster cannot discover or pull the catalog and receives
  no private graph data;
- after the authorized receiver has synchronized, the ordinary membership
  removal workflow advances finalized state, canonical authority
  reconciliation adopts it, and the surviving provider rejects the former
  member's next catalog pull;
- a nonmember query on an authorized node returns no VM rows;
- both complete providers stop, the cold receiver restarts with the same peer
  identity and durable stores, and its exact head, SWM, and VM remain present.

Every child reports its authoritative loopback JSON-RPC method counts only
after the agent has drained recurring and background work. The verdict uses
those shutdown receipts for its source, provider, receiver, outsider, and
restart evidence. The run fails if an unexpected method is used or if a
per-method or total request ceiling is exceeded. These ceilings are regression
guards for this deterministic scenario, not production capacity estimates.

## Run

Build the workspace packages first, then use Node 22:

```sh
pnpm --filter @origintrail-official/dkg-agent devnet:rfc64-private-release-gate
```

The deterministic contract checks are also part of the required repository
tooling lane and can be run directly. The route executes concern-named modules
for artifact failure handling, finalized-chain authority, memory evidence,
revocation workflow, RPC evidence, and transport policy:

```sh
pnpm --dir packages/agent test:rfc64-private-release-gate:unit
```

The command writes a sanitized strict verdict to
`devnet/rfc64-private-catalog/artifacts/latest.json`. It does not write wallet
keys, signed transactions, raw protocol messages, policy bodies, or KA bundle
bodies to the artifact.

The revocation check intentionally leaves the receiver's already committed
local SWM and VM intact. Revocation blocks later network reads; it does not
retroactively erase bytes the former member legitimately received.

Set `DKG_RFC64_PRIVATE_KEEP_RUN=1` only when local failure investigation needs
the temporary process data directories. The default removes them.

## Limit

This is a real separate-process DKG/libp2p/store gate. The finalized chain is a
deterministic loopback JSON-RPC service and package chain adapter. It exercises
the production strict-finality read, private reconciliation, SWM activation,
and finalized VM materialization paths. It does not start Hardhat through
`scripts/devnet.sh`, and it does not use the CLI daemon. A full CLI/Hardhat gate
needs a supported private catalog authoring command and a two-stage manifest
generator because the private activation manifest depends on the final peer
identities and chain anchor.
