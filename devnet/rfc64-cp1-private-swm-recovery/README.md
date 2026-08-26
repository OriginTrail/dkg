# RFC-64 Release 1 private SWM recovery canary

This canary starts two real `DKGAgent` operating-system processes. Both nodes
accept one invite-only policy and its exact member roster. The receiver first
rejects an unbound peer. The harness then installs the explicit peer-to-agent
bindings, publishes 32 SWM assets, and requires exact 32/32 semantic recovery.

Run from the repository root after committing all source changes:

```sh
pnpm run test:m1:rfc64-private-swm-recovery
```

The canary does not enable VM recovery. VM support belongs to the next release.
