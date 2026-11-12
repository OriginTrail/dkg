# Native parameter preflight — PR #3836 review round three

Starting head: `44abb13eedba98dad65463afc9de2f2a4c128444`.
Addresses discussions 4541626500, 4541626517, 4541626527 and 4541626536.

Compiler 9 validates both the pinned public argument interface and every block's
resolved native parameters at native admission. The native workflow therefore
rejects a downstream HTTP URL that the public string schema alone would accept,
before releasing an earlier effectful block. Host, generated Program and native
admission are exercised with the same invalid downstream URLs and valid/defaulted
arguments. The per-component guards remain in place for actual row validation.

Raw invocation validation now has a dedicated `normalizeComponentEnvelope` helper.
It validates JSON structure, row/parameter budgets, reserved fields and execution
identity without inventing or altering a component descriptor. Bound entry rows
are subsequently checked against the real descriptor. Old compiler 6/7/8 sources
retain their frozen helpers and exact identities; compiler 9 has a new frozen
envelope/entry artifact. Direct graph normalization admits `inputs` and
`inputValues` without recursive field removal and reconstruction.

The Studio inventory route fetches native capabilities once, shares that snapshot
with recipe projection, and starts Program and saved-workflow reads concurrently.
HTTP regression coverage checks one native query and metadata pair per component,
independent reads while the native catalog is blocked, unchanged responses, and
the existing fallback for unavailable or malformed recipe catalogs.

## Verification

- `pnpm test:studio`: 58 contract tests and 516 Studio tests passed.
- Signed Studio authority and n8n fingerprint suites: 16/16 passed, including
  compiler-9 replay/reopen, authority changes, recovery and the 35-second callback.
- Frozen compiler 6/7/8 source snapshots, including a graph with both named inputs
  and fixed input values, retain their source hashes and native/KA pins.
- Native n8n 2.43.8 expression verification: four valid/defaulted cases and seven
  rejections passed, including Google Sheets followed by an invalid HTTP URL.
  No Google credentials or real Google operations were used.
- Real local n8n: raw dispatch to an Edit Fields → HTTP Request workflow rejected
  three invalid downstream URLs at admission, with zero component nodes executed
  (executions 23–25; digest
  `14e845f62273ea1a274deae85bc5cd8abe2ea5869e18627aa31dbd488c23bafb`).
  A separate compiler-9 count/data-binding workflow retained two successful
  valid/defaulted runs and rejected four malformed argument cases before components.
  Temporary workflows were removed; both existing FAIR workflows remain saved/active.
- Lint, file-size audit and the implementation fingerprint check passed.

The native HTTP probes bypass host admission on an isolated loopback fixture.
They do not qualify a deployed nOS/MCP/signed-Program/real-node chain. Existing
immutable native workflows require a new save to install compiler-9 preflight.
