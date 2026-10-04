# Devnet observations — Workstream 1, first delivery

The base is `origin/main` at `abfd785d3cf4da01147c3dbfea8d62dd0772150a`
(v10.0.20). The checkout remote was verified as OriginTrail/dkg. No applicable
AGENTS.md or CLAUDE.md was found in the checkout or its ancestors. The primary
checkout was clean and left on its existing branch. After fetching, main was
still the audit revision. The sharing and comprehensive scripts were identical
on the newer testnet-canary branch. Pending PR #2800 also changes sharing port
handling and devnet setup; these changes will need integration with that PR.
PR #1571 changes nightly sweep tooling, which this delivery does not edit.

## Observation interface

`parseObservation({transportExit, httpStatus, body, format, mode, binding})`
is pure. `format` is `api` (default) or `sparql`; `mode` is `count`, `rows`, or
`json`. COUNT defaults to binding `cnt`; callers select the actual alias, never
fall back to a different column. Successful values are normalized decimal
**strings**, including values larger than either JS safe integers or Bash
machine integers. JSON numeric cells are not a supported COUNT wire form.

Results carry `outcome`, a stable `reason`, and a `value` only on PASS. Row
observations also carry `rows`. `assertObservation(observation, 'eq'|'ge',
expectedDecimalString)` separates valid observation from assertion evaluation.
`resultExit` maps PASS/FAIL/INCONCLUSIVE to 0/1/2. Diagnostics contain no response
body, token, URL, config, or subject values.

| Stage | Representative reason | Outcome |
| --- | --- | --- |
| curl failed | TRANSPORT_FAILURE | INCONCLUSIVE |
| HTTP not 2xx | HTTP_ERROR | INCONCLUSIVE |
| API error envelope, including HTTP 200 | API_ERROR | INCONCLUSIVE |
| malformed JSON/result/bindings | MALFORMED_JSON / INVALID_RESULT / INVALID_BINDINGS | INCONCLUSIVE |
| missing COUNT alias | MISSING_BINDING | INCONCLUSIVE |
| zero or multiple COUNT rows | AMBIGUOUS_COUNT_ROWS | INCONCLUSIVE |
| malformed, negative, noninteger or unsupported COUNT term | INVALID_COUNT | INCONCLUSIVE |
| valid parsed observation | VALID_OBSERVATION | PASS |
| valid count violates the assertion | ASSERTION_FAILED | FAIL |

`devnet_capture <curl arguments>` emits `curlExit LF httpStatus LF body`. Capture
always carries the real curl exit; it does not turn an HTTP failure into a JSON
success. `devnet_observe count|rows|json <binding> api|sparql [eq|ge expected]`
consumes that frame. It emits a value only on PASS and uses 0/1/2. The `json`
mode adapts validated rows to the DKG `{result:{type:'bindings',bindings}}` shape.

Call sites explicitly branch on status, including both acquisition and parsing:

```bash
response=$(devnet_capture -X POST -H 'Content-Type: application/json' \
  --data "$query_body" "$api/api/query") || devnet_observation_abort
count=$(printf '%s' "$response" | devnet_observe count cnt api) \
  || devnet_observation_abort
```

`devnet_observation_abort` is an explicit legacy adapter: it identifies invalid
evidence as INCONCLUSIVE, then exits **1**, preserving the existing public suite
semantics. The sharing script's body-only helpers are adapters over responses
whose transport/envelope were already validated by `query_api` or
`storage_query`. Threshold comparisons use BigInt, avoiding Bash overflow.
Node 22 is sufficient; the parser/wrapper do not require a product build.

## Supported wire forms and sources

- `packages/cli/src/daemon/routes/query.ts`, `normalizePublicApiQueryResult` and
  `/api/query`: `{result:{type:'bindings',bindings:[...]}, phases:{...}}`.
  The explicitly supported earlier API envelope omits `result.type`.
- `packages/query/src/query-engine.ts` and
  `packages/storage/src/adapters/oxigraph.ts`: rows contain canonical term
  strings, formatted by `formatCanonicalRdfTerm` from rdf-utils.
- `packages/storage/src/sparql-json-query-result.ts` and
  `devnet/_bootstrap/harness.ts` binding helpers: SPARQL Results JSON uses
  `head.vars` and `results.bindings` with term objects; historic API cells can
  also contain these objects. The new parser does not reuse `lexical()` or
  permissive `sparql_count` functions that strip prefixes without validating
  the complete COUNT term.
- The COUNT parser recognizes the narrow integer subset of the canonical RDF
  grammar: bare decimal strings, canonical `"digits"^^<XSD integer datatype>`
  strings, and typed literal objects. It validates XSD integer subtype ranges
  and preserves precision with BigInt. Language strings, xsd:string, decimal,
  double, arbitrary digit-containing strings, and escaped/non-integer lexical
  forms are rejected. It is not a second general-purpose RDF parser.

Sanitized representative fixtures are in
`../__tests__/fixtures/query-observation/`: canonical zero, a large integer,
SPARQL typed positive, and a scoped-query API error. They are constructed from
the source wire contracts, not presented as captured live-node receipts.

## Claims and authorized observations

Sharing queries about actual named assertion graphs or `_meta` storage use the
node's configured raw HTTP store. The resolver accepts only a devnet directory
directly inside this checkout, a matching API port, loopback RPC/endpoint, and
chain ID `evm:31337`. Supported stores are managed oxigraph-server, sparql-http,
and Blazegraph. Embedded Oxigraph has no safe live HTTP observation and is
INCONCLUSIVE; its data is never opened or rewritten by this helper.

Every raw read first queries seeded devnet triples as a positive control.
The first isolation check also proves the owner actually has the assertion
graphs. The smoke exposed that current WM data uses numeric `_working_memory`
graphs; graph isolation queries now cover that family and the supported legacy
`/assertion/` family from `DKGPublisher.wmGraphUri`. A graph-name substring
`doc-alpha` cannot identify numeric graphs, so that check observes physical WM
absence in both families for the same CG, with an owner control after promotion.
Lifecycle/event/import metadata and post-promotion WM metadata checks have
matching owner controls before asserting peer absence. Raw result headers
must declare the first projected variable. A failed or empty control blocks
absence acceptance. The local fixture test deliberately returns an ACL-filtered
empty API view while the raw store contains a seeded private assertion; the
physical zero assertion correctly fails.

Scoped API queries remain observations of WM/SWM/VM **visibility**. Four API WM
view checks use SELECT cardinality instead of COUNT, because an ACL-filtered
empty SELECT is a valid visibility observation while zero COUNT rows are invalid.
Physical graph/meta claims were not changed to visibility claims.
`API_PORT_BASE` and `DEVNET_DIR` let sharing run on an isolated layout.

## Sibling migration and remaining work

Small direct fixes with parent-shell tests:

- `v10-rc-validation.sh`: four absence observations (peer/private email,
  publisher/private email, peer WM, and subgraph/root view) no longer default
  invalid observations to zero.
- `devnet-probe-cg-phonebook.sh`: both COUNT observations validate transport,
  envelope, alias `n`, row cardinality and integer term. Invalid cross-peer
  evidence can no longer become an advisory warning/pass. Valid zero retains
  the existing advisory behavior.
- `devnet-test-invite-flow.sh`: outsider API visibility check no longer turns an
  API error into empty bindings. Its separate physical store checks remain.

The inspected release-selected inventory is the union of comprehensive,
full-sweep, and rfc38-all, plus the RC12 release validator:

```
_devnet-full-sweep.sh
devnet-probe-ack-rejection-reasons.sh
devnet-probe-cg-phonebook.sh
devnet-probe-hub-rotation.sh
devnet-probe-libp2p-tunables.sh
devnet-probe-multi-rpc-failover.sh
devnet-rc12-release-validation.sh
devnet-soak-rs.sh
devnet-swm-soak-gate.sh
devnet-test-cli-invite.sh
devnet-test-invite-flow.sh
devnet-test-node-ui-smoke.sh
devnet-test-publish.sh
devnet-test-random-sampling.sh
devnet-test-rc11-promote-crash-recovery.sh
devnet-test-rc11-shutdown-mid-publish.sh
devnet-test-reject-flow.sh
devnet-test-rfc38-all.sh
devnet-test-rfc38-cross-cg.sh
devnet-test-rfc38-curator-offline-midbatch.sh
devnet-test-rfc38-e2e.sh
devnet-test-rfc38-late-joiner.sh
devnet-test-rfc38-lu10.sh
devnet-test-rfc38-lu5-public.sh
devnet-test-rfc38-lu5.sh
devnet-test-rfc38-lu7.sh
devnet-test-rfc38-lu8.sh
devnet-test-rfc38-lu9.sh
devnet-test-rfc38-multi-member.sh
devnet-test-rfc38-revocation.sh
devnet-test-rfc38-scale.sh
devnet-test-rfc38-unclean-restart.sh
devnet-test-rfc49-catalog-sampling.sh
devnet-test-sharing.sh
devnet-test-swm-ownership-restart.sh
libp2p-soak-test.sh
v10-rc-validation.sh
```

Follow-ups left to subsequent migrations, rather than changing their recovery
contracts mechanically:

- RFC38 curator-offline-midbatch, revocation and late-joiner use permissive
  `sparql_count` prefix parsing; unclean-restart uses a jq/sed numeric prefix.
  Their deadline/recovery adapters and mixed backend observations need targeted
  scenario tests before switching semantics.
- Invite-flow has other metadata/ownership readers with missing-binding
  defaults, and a raw store COUNT helper that reads only its first row. This PR
  fixes the direct outsider API false pass, not the complete invite suite.
- RC12 release validation has default-binding readers for VM presence and
  peer replication; their positive thresholds currently fail on zero, but
  transport versus invalid response is not distinguished. This release tooling
  belongs to its owner.
- SWM ownership/restart uses strict positive assertions but does not fully
  distinguish HTTP/API observation failure. Publish, reject, CLI invite and
  random-sampling mix endpoint-specific result/error checks; they need their
  own envelope migrations, not a generic query rewrite.
- Several RFC38 suites default missing log baselines to zero; hub-rotation and
  phonebook identity checks default missing identity fields; libp2p soak has
  grep-count fallbacks. These are log/identity/delivery observations outside
  this query parser's contract.
- The SWM soak preflight already requires both seeded cross-peer subjects and
  rejects malformed/error responses; full-sweep and rfc38-all already treat
  MISSING as nonzero. They were inspected and retained.

No CI workflow, root package.json, test route, release command, regression
registry or acceptance profile is changed.

## Comprehensive runner boundary

The runner writes PLAN.json before executing its registered selection, then
REPORT.json with individual PASS, FAIL:<original code>, MISSING, CANCELLED and
NOT_RUN states. While work is active it records RUNNING. The pure summary
preserves confirmed failures alongside incomplete evidence; empty,
zero-executed, missing or unfinished runs are INCONCLUSIVE. A complete run with
only valid suite exit zeros remains PASS.

The report writer is an explicit legacy-exit adapter: complete selection success
returns 0; selection failures/incompleteness return 1. Preflight exit 2 and
signal exits 130/143 remain unchanged. Existing suite exit 2 remains FAIL:2;
it is never guessed to mean the new observation helper's INCONCLUSIVE state.

Skip flags and SOAK_ONLY are recorded as `filters`. A completed filtered
selection may return legacy exit 0 for exploration, but `partial:true`, overall
`outcome:INCONCLUSIVE` and `completeSuccess:false` prevent it from certifying a
complete run. `selectionOutcome` describes only the selection. This is not an
acceptance profile or release receipt system.

## Verification

Run the focused files and the existing tooling lane:

```bash
node --test scripts/lib/__tests__/query-observation.test.mjs \
  scripts/lib/__tests__/devnet-comprehensive.test.mjs
pnpm test:scripts
pnpm lint
pnpm test:inventory
```

The focused lane exercises the real Bash wrapper, a local HTTP fixture, actual
sharing/RC/phonebook/invite parent-shell statements, authorization/physical
controls, and the real comprehensive script with disposable fixture suites.
The missing-only, empty, fail-fast, mixed FAIL/MISSING, cancelled and complete
cases are behavioral tests, not only reducer tests.

### Observed results on this branch

- Focused parser/wrapper/parent-shell and comprehensive tests: **72 passed,
  0 failed** (63 observation tests and 9 runner tests).
- Existing `pnpm test:scripts` lane: **474 passed, 0 failed**.
- `pnpm lint`: exit 0; incoming-copy boundary 0 violations; disabled-test
  audit 64 existing findings and 0 additions. No lint baseline was changed.
- `pnpm test:inventory`: exit 0; 2,108 test files verified across 22 Vitest
  packages and explicit secondary systems. No route change was needed.
- Bash syntax checks for the six touched shell files and `git diff --check`:
  exit 0.
- Local prerequisite build, using Node 22.23.2:
  `pnpm -r --filter @origintrail-official/dkg... --filter '!@origintrail-official/dkg-evm-module' run build`:
  exit 0. Native SQLite was rebuilt locally for the installed Node ABI.

The full sharing smoke ran on a fresh five-node devnet in this worktree using
Hardhat :18547, APIs :19401–19405, libp2p :20401–20405 and managed Oxigraph
:17901–17905. Its overlay used only local bootstrap peers/RPC, disabled updates,
and no public relays. It created and imported the private project, completed
join/approval, and passed the raw physical graph/lifecycle/event/import-metadata
isolation checks (sections 3a–3d). At section 3e the scoped API returned HTTP
503 with code `CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE`; the strict adapter
printed INCONCLUSIVE and aborted the suite with legacy exit 1. The full sharing
suite therefore **did not pass or complete**. Later sharing sections and the
mixed-backend matrix are unvalidated. The disposable nodes and chain were
stopped; generated deployment changes were restored. No existing node data or
public network was used. Comprehensive behavior is validated with disposable
fixture suites, not claimed as a real complete release devnet run.

### Defect-restoration demonstrations

After restoring only the exact `count_integer` function from the base revision,
this regression exited 1:

```bash
node --test --test-name-pattern='parent sharing shell rejects ambiguous COUNT' \
  scripts/lib/__tests__/query-observation.test.mjs
```

The tested parent incorrectly exited **0**, printed `FALSE_PASS`, and made the
assertion fail (`expected: 1`, `actual: 0`). The response had zero COUNT rows;
the original parser invented zero. Restoring the fixed function makes it pass.

After temporarily restoring the complete original `devnet-comprehensive.sh`,
this regression also exited 1:

```bash
node --test --test-name-pattern='missing-only run is incomplete and nonzero' \
  scripts/lib/__tests__/devnet-comprehensive.test.mjs
```

All **15** registered suites were MISSING, with PASS=0 and FAIL=0, yet the tested
original runner exited **0** (`expected: 1`, `actual: 0`). Restoring the fixed
runner makes it pass. Both demonstrations restored the fixed source before the
final focused/tooling validation; neither defective variant is committed.
