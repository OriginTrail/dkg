# RFC-64 Release 3 private provider failover canary

This canary starts four real `DKGAgent` processes: one author, two complete
private providers, and one cold receiver. Both providers first apply the exact
private catalog. The cold receiver discovers the same exact head from both.
The harness then terminates provider A during KA-bundle transfer. The ordinary
receiver scheduler must switch to provider B and complete the exact SWM and VM
state without a terminal failure.

Run from the repository root after all source changes are committed:

```sh
pnpm run test:m3:rfc64-private-provider-failover
```

The default proof is 32/32 SWM and 32/32 VM. Set
`DKG_RFC64_PRIVATE_FAILOVER_ASSET_COUNT` to run another bounded size from 2 to
128.
