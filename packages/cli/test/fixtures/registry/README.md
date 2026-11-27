# Vendored registry fixtures

Verbatim copies of the live entries on `OriginTrail/dkg-integrations@main`, plus
the published JSON Schema they are validated against.

They exist so `integrations.test.ts` can assert that **every entry the registry
can merge is readable by this CLI** without making the suite network-dependent.
That contract had no test, and the CLI's hand-written validator silently drifted
stricter than the schema in three places — `manual` required a `steps` field the
schema forbids, `mcp` required the schema-optional `args`, and `service` rejected
the schema's `binary` runtime. Every `manual` entry was dropped as "unreadable"
by both `dkg integration` and the node dashboard.

Refresh deliberately (a PR, not a script) when the registry gains an entry shape
worth pinning:

    curl -s https://raw.githubusercontent.com/OriginTrail/dkg-integrations/main/integrations/<slug>.json \
      -o packages/cli/test/fixtures/registry/<slug>.json

Staleness here cannot produce a false green: the per-install-kind cases in
`integrations.test.ts` are derived from the schema itself and are independent of
these copies.
