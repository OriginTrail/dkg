# Context Graph write-preflight failures

A `503 CONTEXT_GRAPH_VALIDATION_UNAVAILABLE` response includes an
`x-dkg-operation-id` header. Search the daemon's retained log for that operation
ID to find the corresponding `write-preflight` diagnostic. The HTTP status,
error code, existing body, authorization decisions and retry deadlines are
unchanged.

The diagnostic reports every failed read site observed by that request, rather
than claiming that the first failure caused all the others. Sites include
`existence`, `content`, `subscription`, `declaration`, `caller-access`,
`exact-probe`, `metadata`, `list`, and the fallback `decision`. Each entry has
one of four closed kinds:

- `store-not-started`: a typed store rejection says the operation did not start.
- `deadline`: a typed store timeout occurred without a not-started outcome.
- `incomplete`: required evidence was absent from the probe's result.
- `unknown`: no supported typed classification is available.

`rescue` separately records whether the existing chain rescue was
`not-attempted`, `unsupported`, `denied`, `deadline`, or `failed`. A failed rescue
does not replace the original failed-site evidence. Successful requests do not
emit this unavailable-response diagnostic.

The new diagnostic fields contain no graph IDs, caller addresses, tokens,
dependency messages, or URLs. There are at most nine site entries. Every actual
503 retains a correlated log line; repeated equivalent failures use info level
after the first warning, with a bounded 128-entry warning cache. The daemon's
file output retains both levels. Diagnostic observer failures cannot change the
response or add dependency reads or rescue attempts.

These diagnostics identify observed failures, not an authorization verdict or
proof that a particular dependency caused an incident. An unclassified error
remains `unknown`; the implementation does not infer causes from error text.
