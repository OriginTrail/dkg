# RFC-64 Release 2 private SWM and VM recovery canary

This canary starts two real `DKGAgent` processes. Both nodes accept one
registered private Context Graph policy and its exact roster. The author
publishes 32 signed catalog assets. The cold receiver must recover exactly
32/32 SWM assets and materialize exactly 32/32 VM assets from the finalized
chain ordinal set.

The canary also proves that an unbound peer cannot receive the private catalog.
It uses only the authorized RFC-64 V2 private transport.

Run from the repository root after all source changes are committed:

```sh
pnpm run test:m2:rfc64-private-swm-vm-recovery
```
