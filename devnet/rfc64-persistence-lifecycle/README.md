# OT-RFC-64 Gate 0: production persistence lifecycle

This bounded runtime gate starts the built, production `DKGAgent` in a real
child process. It stages one deterministic, signature-verified control object
through the agent-owned RFC-64 persistence boundary, proves that another
process cannot acquire the inventory lease, then exercises both shutdown paths:

1. graceful `SIGTERM` -> `DKGAgent.stop()` -> successful restart;
2. `SIGKILL` (no JavaScript cleanup) -> operating-system lease recovery.

Each restarted agent re-reads and cryptographically verifies the exact durable
object before the harness compares byte hashes, object/signature counts, and
owner-only file modes. The result is written as stable, sorted JSON without
timestamps, PIDs, durations, or temporary absolute paths.

Run from the repository root:

```sh
pnpm test:gate0:rfc64-persistence-lifecycle
```

The default artifact is:

```text
devnet/rfc64-persistence-lifecycle/artifacts/gate0-result.json
```

Set `DKG_RFC64_GATE0_ARTIFACT` to override that path. The gate deliberately
does not add an HTTP/API route. Its only control channel is the parent/child
stdio and process-signal boundary. A shared `scripts/devnet.sh` cluster is not
required: RFC-64 persistence is acquired before networking, and isolating this
gate avoids mutating a developer's existing devnet.
