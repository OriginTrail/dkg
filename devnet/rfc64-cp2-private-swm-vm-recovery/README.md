# RFC-64 Release 2 private SWM and VM recovery canary

This canary starts two real `DKGAgent` processes. Both nodes accept one
registered private Context Graph policy and its exact roster. The author
publishes 32 signed catalog assets. The cold receiver must authenticate and
activate exactly 32/32 SWM catalog payloads, materialize exactly 32/32 VM
assets from the finalized chain ordinal set, and then retire exactly 32/32
duplicate SWM twins. The durable synchronization evidence proves the catalog
activation. For every KA, the receiver also exports a production-owned
lifecycle receipt bound to the exact catalog head, inventory digest, VM graph,
and VM post-read digest. The canary requires its monotonic order to be VM
transaction commit, durable applied-head observation, then SWM reconciliation;
an early retirement cannot pass merely because VM appears later. Exact empty
SWM graph readback plus exact VM bytes and metadata independently prove the
intentional post-finalization retirement rather than data loss.

The scale fixture does not build 500 cumulative exact sets. For a 500-asset
run, it stages the
first 499 deterministic rows in bounded batches of at most 64, then calls the
production exact-set successor once to add row 500 and commit the exact
500-row catalog. This preserves the product's one-row ordinary-successor rule
while keeping fixture construction linear. The verdict artifact records the
batch sizes and the production successor count. The fixture predecessor is
never announced or applied on the receiver; only the final production head is
sent through the private V2 transport.

The canary also proves that an unbound peer cannot receive the private catalog.
It uses only the authorized RFC-64 V2 private transport.

Run from the repository root after all source changes are committed:

```sh
pnpm run test:m2:rfc64-private-swm-vm-recovery
```

Use the same product canary for the bounded 500/500 scale gate:

```sh
DKG_RFC64_PRIVATE_ASSET_COUNT=500 \
  pnpm run test:m2:rfc64-private-swm-vm-recovery
```
