---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Keep managed Blazegraph responsive

Fresh DKG-provisioned Blazegraph containers use a named journal volume, the
existing bounded local log policy, a bounded JVM heap, and
`-XX:+ExitOnOutOfMemoryError`. The last flag lets Docker's restart policy
recover when the JVM runs out of memory instead of leaving Tomcat alive but
unresponsive. The container health check runs a bounded empty-pattern ASK.

The default heap is 40% of host RAM, clamped to 2–8 GiB. Set
`DKG_BLAZEGRAPH_HEAP_MB` to a positive decimal number of MiB to override it when
provisioning or migrating. This changes the container's JVM options; restarting
an existing container does not rewrite those options.

The daemon also probes external stores while running. After six consecutive
failures it may restart a **DKG-managed Blazegraph** container, at most once
per 30 minutes. Other external stores are monitored and logged, with no Docker
restart. Boot recovery uses a persisted cooldown to prevent daemon restart
loops from repeatedly restarting a cold store. `DKG_STORE_MONITOR_DISABLED=1`
disables the runtime monitor. `/api/status` includes its counters.

## Migrate an existing container

Migration is a manual operator action. It can also harden containers that
already have a journal volume but lack the JVM or health-check options.
Point `DKG_HOME` at the same configuration directory the daemon uses, then:

```bash
dkg store harden --dry-run
dkg stop
dkg store harden
dkg start
```

Review the dry-run plan first. The command applies only to a configured
Blazegraph store marked `managedByDkg: true`. It checks available disk space,
stops the container, exports the journal, seeds a **separate** migration volume,
and renames the old container to `<name>-backup`. The old container and its
original volume remain intact. It creates the replacement on the same host
port and verifies readiness, an ASK, the store identity tag, and journal size.

A failure after the rename triggers rollback. A failed rollback reports the
remaining commands for manual recovery. No migration path removes the backup
container or the exported journal. Keep those recovery copies until the
replacement has been checked. Migration uses an exclusive lock that blocks
daemon startup and suspends automatic store restarts; if a process is killed, inspect the container and lock
before removing a stale lock and resuming.

`--migration-dir` chooses the export directory, `--port` must match the configured
store endpoint, and `--container` overrides the derived container name. Stop the
daemon with `dkg stop` before executing a migration. `--yes` only skips the
confirmation prompt; it cannot permit live writers during verification or rollback.
Read-only `--dry-run` remains available while the daemon is running.
