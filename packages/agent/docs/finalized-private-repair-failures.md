# Finalized-private catalog repair failures

A confirmed private publication can still owe its catalog placement. Its canonical
repair marker remains the obligation until the existing repair path verifies and
completes it. Failure classification, retry timing and operator retry never grant
authority, replace a seal, publish another asset or acknowledge that obligation.

Private placements now retain one bounded failure record per marker in the owned
inventory SQLite database. It records the closed failure kind, consecutive and
same-kind counts, first and last failure timestamps, next retry time and parking
state. It contains no dependency error text. Successful exact marker deletion
cascades to its failure record. An idempotent marker put preserves that history.
Invalid diagnostic records are ignored; canonical markers remain intact.

Same-kind private failures back off exponentially from the configured repair
interval (five seconds by default), up to thirty minutes. Three consecutive
`policy_conflict`, `version_conflict` or `signer_mismatch` failures park that
marker. These conditions require investigation or a configuration/authority
correction; repeated signing or storage operations do not repair them. Unknown,
store-pressure, transport, inactive-lane and unavailable-persistence conditions
remain retryable. A real observed inactive/active lane transition can also reset
scheduling. Public catalog reconciliation retains its existing retry policy.

`GET /api/status` reports the additional `failures` aggregate inside
`rfc64Catalog.finalizedPrivatePlacementQueue`: `failedMarkers`, `parkedMarkers`,
`maxConsecutiveFailures`, `oldestFailureAgeMs`, and bounded per-kind counts. This
is loaded failure evidence for the supervisor's owed queue, including parked
entries. Failure age survives restart; the existing pending-queue age remains a
process-local observation. Wall-clock changes can affect age; a restored transient
retry delay is capped at thirty minutes. No graph, author, KA, marker digest or
raw error is exposed by the aggregate.

After correcting a parked condition, a node operator can send:

```sh
curl -X POST -H "Authorization: Bearer $DKG_OPERATOR_TOKEN" \
  "http://127.0.0.1:$DKG_API_PORT/api/rfc64/private-placement/retry-failed"
```

Use the configured daemon address and existing authentication policy. Agent-scoped
tokens cannot administer this endpoint. When authentication is disabled, it has
the same trusted-local administrative behavior as the other node controls.
A `202` response contains only `{ "requested": N }`. It means failed owed work was
rescheduled, not that placement succeeded. Retry resets its failure streak and
cooldown, retains its first/last failure evidence, and fences older in-flight
failures from restoring the prior schedule. An actual successful in-flight repair
may still complete its marker. A `503` reports that scheduling was unavailable;
markers remain owed, and a partial retry should be checked through status.

The migration from inventory schema 5 to 6 adds a foreign-key-cascaded diagnostic
table only. Canonical marker bytes and digests, existing signatures, and placement
checks are unchanged. Migration uses the existing owned SQLite schema validation
and transaction path. **An older binary that supports only schema 5 will refuse
the upgraded database.** Plan rollback using the deployment's existing backup and
compatible-binary procedure; do not manually lower `user_version` or discard owed
markers to start an old binary.

Regression coverage includes baseline failures for excessive retries and inactive
lane classification; exact SQLite persistence, schema migration, corrupt hints,
restart/parking/operator retry; stale-attempt fencing; and HTTP admin scope and
aggregate redaction. A native node restart test exercises the real agent startup,
owned inventory and Oxigraph paths against an inactive marker without a mocked
repair implementation. These tests do not establish the cause of every historical
`unknown` failure reported in issue #3178.

Catalog-capacity parking keeps its existing applied-head wakeups and hourly
safety-net rotation. Its failure kind, count and age remain visible and durable,
with no generic private-failure cooldown, so freeing a row can admit owed
placement in the next pass. Operator retry cannot let an older failed attempt
restore either generic backoff or capacity parking. Already parked capacity
work still waits for its existing head-change or safety-net condition.
