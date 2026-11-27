# Generic native execution verification and continuation

The user's HTTP invocation reached n8n successfully: provider execution 42 at
2026-10-24 12:10:42 UTC returned Berlin temperature 11.1 degrees Celsius. DKG
retained an unknown effect because the execution snapshot removed inactive body
fields and an expression prefix. Those normalized parameters cannot be compared
as a second immutable workflow definition.

Native verification now binds the provider-reported execution version to the
durable acknowledgement and the full published workflow digest. The complete
published parameters remain covered by the owner-approved digest. The execution
must also preserve graph connections, node types/settings and credential
references. This is a shared native-adapter rule for every component; there are
no endpoint, URL or method exceptions. It trusts the operator's n8n API to report
the actual immutable published-version identity.

Failed native-only TypeScript invocations can continue the same identity when
every original effect has a durable matching n8n acknowledgement. Continuation
only inspects original effects. It cannot start a new tool or child call, cannot
change inputs or authority, and cannot persist a receipt with unresolved effects.
Missing acknowledgements and other interrupted TypeScript workflows retain their
non-retryable behavior. No journal rows were edited manually.

Validation:

- 29 native/legacy adapter tests passed, including normalized parameters,
  changed published parameters, versions, graph, node types/settings, credential
  references, scoped observations and continuation without another POST.
- All 97 semantic runtime configuration/API tests passed. The new native cases
  restart the runtime after an interrupted read, complete and persist the same
  provider execution, reject changed input/version, forbid new calls during
  continuation, and leave a lost acknowledgement non-retryable. Dispatch count
  remains one throughout each case.
- CLI build:compile and test:types passed. Root lint and git diff checks passed.
- A read-only replay of the real stored execution 42 returns
  sourceHashMatches=true, oldSnapshotMatch=false, publishedVersionMatch=true.
  This did not issue a provider request or create a new execution.
- URL-validation lint annotations are outside serialized functions. Both
  serialized URL validator and input resolver are byte-for-byte unchanged, so
  existing component sources and workflow pins are preserved.

This verifies adapter behavior and signed in-process API/receipt persistence.
The stored real execution replay is not a new authenticated live UI test.
Browser automation remains denied by the browser permission gate despite the
user-visible Always allow setting. After loading the backend fix, the existing
UI request can use Retry same request to inspect its acknowledged execution.
