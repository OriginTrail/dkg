# RFC-64 private catalog Releases 1-3 gate

This gate validates private RFC-64 recovery across four real `DKGAgent` OS
processes. It uses the production libp2p router and private V2 catalog
protocols. Every process has a persistent Oxigraph graph store and the normal
durable RFC-64 control-object, KA-bundle, and inventory stores.

The topology is:

- one private CG owner and complete provider;
- one authorized receiver that becomes the second complete provider;
- one authorized cold receiver;
- one node that is not in the roster.

The test publishes two catalog assets before receivers start. It then proves:

- the first receiver gets the exact signed private catalog, SWM, and finalized
  VM from the owner;
- the owner stops, and the cold receiver gets the same exact state from the
  second provider;
- the node outside the roster cannot discover or pull the catalog and receives
  no private graph data;
- a nonmember query on an authorized node returns no VM rows;
- both complete providers stop, the cold receiver restarts with the same peer
  identity and durable stores, and its exact head, SWM, and VM remain present.

## Run

Build the workspace packages first, then use Node 22:

```sh
pnpm --filter @origintrail-official/dkg-agent devnet:rfc64-private-release-gate
```

The command writes a sanitized strict verdict to
`devnet/rfc64-private-catalog/artifacts/latest.json`. It does not write wallet
keys, signed transactions, raw protocol messages, policy bodies, or KA bundle
bodies to the artifact.

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

