# Beacon reliability follow-up — 2026-09-08

These changes address four recovery gaps observed or reproduced while investigating stuck testnet publishes. They are prepared for review; the live beacon release has not been replaced with this patch.

## Changes

1. **Watchdog death must release the database.** The Linux scoped watchdog starts Oxigraph with a kernel parent-death signal through util-linux `setpriv`. A post-installation parent check closes the launch race. A child that resists a forwarded shutdown signal is killed after five seconds. Existing startup ownership checks remain intact; no database or lock files are deleted.
2. **Cancelled reads retain a recovery deadline.** Closing an HTTP request does not stop Oxigraph 0.5.8 query evaluation. Managed reads cancelled before their normal client deadline now retain that deadline for recovery. Timers coalesce per adapter, ignore replaced database generations, and are cleared on store close. Caller cancellation semantics stay intact. Mutations do not acquire this recovery trigger.
3. **Updates stop reusing obsolete workspace copies.** Before installation into the inactive git slot, undeclared unpacked root copies of current workspace packages move to a quarantine directory. Declared dependencies, pnpm links, unrelated packages and incremental build caches remain. Cleanup failure prevents installation and activation. This reproduces and corrects the stale publisher package that defeated the TypeScript package-exports assertion on beacon03.
4. **Supervisor liveness requires an HTTP response.** A TCP handshake can succeed while the worker's event loop cannot process requests. The probe now sends a cheap HEAD request to an unknown API route and requires a valid HTTP status line within one absolute five-second deadline. Any HTTP status counts as liveness, so an unavailable store or an authentication response does not itself force a restart. The existing five consecutive failures, 30-second interval and bounded shutdown grace remain.

## Validation

- `pnpm build:runtime:packages` passed; CLI TypeScript was checked again after the supervisor change.
- 300 focused tests passed across the updater, watchdog, supervisor, managed server and SPARQL HTTP adapter. Three environment-specific cases were skipped by the local suite.
- Linux scratch-database fault injection with the deployed Oxigraph 0.5.8 binary reproduced an orphan and database-lock failure with the old watchdog. With the new watchdog, its child exited in 3 ms after watchdog SIGKILL; the same database reopened and retained its committed test triple.
- A real Linux query was cancelled by its client in 113 ms but consumed another 40 CPU ticks over the next 400 ms. With a 1.5-second test deadline, the new callback caused one recovery and returned a correct 100-row count from the reopened database in 1,581 ms. The harness supplied the restart callback; separate supervisor tests exercise verified listener signalling and replacement.
- The real TypeScript resolver follows the obsolete root package before quarantine and rejects that forbidden import afterward.
- Supervisor tests include a TCP listener that accepts connections but never returns HTTP, and an incomplete response that trickles bytes. Both fail within the total deadline.

The Linux checks used separate temporary databases and ports on beacon01. They did not publish to the blockchain or modify the beacon database.

## Rollout and remaining work

Roll through the normal release path, one beacon at a time. Before each restart, check the other three nodes' API response latency, store reads and StorageACK readiness; wait for the updated node to regain these before proceeding. Test a representative publish and cancellation/retry flow on the first canary. Preserve the existing sync throttles during this rollout.

All four nodes had update jitter explicitly disabled. A 30-minute update-jitter window can reduce overlapping updates, but randomness cannot guarantee that three nodes remain available. A fleet rollout gate that allows only one unavailable beacon is the stronger protection. The on-chain minimum observed during the incident was three signatures; its effect depends on the publisher's eligible candidate pool.

Recovery is conservative: an abandoned query may already have finished without confirmation. Restarting the managed database can interrupt concurrent writes. Preserve the same operation identity and use the existing indeterminate-outcome reconciliation; do not create a new asset or claim an interrupted write succeeded.

These changes do not prove the original watchdog exit cause or identify every expensive query behind beacon03's earlier saturation. They also do not resolve the historical finalization conflicts or certify the user's specific stuck publish without its operation identifier.

A later live check found beacon04's worker near its 1.5 GiB cgroup cap with 4,166 open file descriptors. Its JavaScript heap used about 509 MB, and a short CPU sample showed substantial Undici HTTP dispatch and garbage collection activity. Its store responded quickly while API requests timed out. This points to RPC/HTTP resource growth that needs separate concurrency, connection-lifecycle and retry analysis; it is not evidence that increasing the JavaScript heap limit is the correct fix. The HTTP liveness change adds recovery for a stalled worker while that cause is investigated.

Further performance work should measure and bound RPC fan-out, back off repeated finalization conflicts, record expensive query fingerprints and queue ages, and verify ACK progress under sustained sync load. A successful API status check alone is insufficient to certify publish health.
