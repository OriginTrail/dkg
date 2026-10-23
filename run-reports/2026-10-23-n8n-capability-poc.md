# n8n capability KA PoC - local verification

Date: 23 October 2026. The DKG branch starts from Graph Computer PR #3427 at
`6bf4c9c38756cc77f0c39e523975f54d45c31c95` and includes freshly fetched
`origin/testnet-canary` at `556ad8d4835278b85ddc17ee140d6fa900ba396e`.
The companion nOS change starts from Ziga's PR #934 at
`4f0dd2eb9d4fb4c61ca0e603640821ef84e7fd16`.

## Runtime evidence

- DKG Node 26.8.2; separate n8n 2.43.8 / Node 24.22.0; nOS Node 22.23.2 / pnpm 11.22.0.
- Real DKGAgent, persistent Oxigraph, native KA create/write/finalize, persistent KA allocator, signed HTTP authentication and nonce storage, real Wasm TypeScript Program execution, SQLite effect and receipt journals.
- Local chain boundary: MockChainAdapter. Private Working Memory; no on-chain transactions or public publication.
- Agent invokes Program KA `urn:demo:n8n:normalize-text:1`, receives `HELLO DKG`, and reads back the matching execution KA. Completed retry keeps the same n8n execution ID.
- A parent Program KA invokes the child through `invoke_program`, returns `COMPOSED DKG` and records both execution references. Its completed retry also keeps the same result.
- Earlier normalization browser verification: existing nOS Network canvas discovers the capability from DKG, invokes it, and shows the real result, n8n execution ID and verified private DKG readback. Browser access to the new CSV screen was declined, so CSV visual verification is outstanding.
- Live regression script confirms no additional n8n executions for completed replay, invalid input, an unauthorized signed caller, viewer/foreign-account requests, a stale KA source hash and a changed published workflow. The owned workflow is restored after the mismatch check.
- The DKG service was stopped and restarted against its persisted node/runtime state; stored Program, approval and execution state remained usable.

Private node homes, credentials, provider history and runtime logs remain outside
the repository. The reproducible scripts write `evidence.json`,
`regression-evidence.json`, `composition-evidence.json`, `csv-evidence.json` and
`csv-composition-evidence.json`, `google-export-effect-evidence.json` and
`normalization-reconciliation-evidence.json` into the chosen local
state directory. They contain execution references and non-secret evidence.

## Validation

| Check | Result |
| --- | --- |
| DKG affected CLI approval, invocation, runtime, adapter and native receipt suites | 241/241 pass, 6 files; unit config |
| OAuth follow-up: native asset/receipt, runtime and n8n adapter suites | 75/75 pass, 3 files; timestamp regression failed before the fix |
| Graph Computer SDK | 37/37 pass, 3 files |
| CLI build and type tests; semantic-runtime TypeScript build | Pass |
| Agent build, type tests and package-root boundary after the canary merge | Pass |
| nOS console and console integration | 1184/1184 pass, 147 files |
| nOS development/production bundle boundary | 1/1 pass |
| nOS console typecheck, production build and changed-file ESLint | Pass |
| Real n8n / DKG invocation, composition, readback, replay and denial checks | Pass |
| DKG full runtime package build, repository lint and libp2p pin check | Pass |
| Google Sheets create/append against a connected account | Pass: two mapped rows, real new Sheet, private receipt readback and completed replay |

## CSV extension

The approved extension uses three separate Program KAs. Parse CSV runs n8n's
Convert to File and Extract From File nodes; Map fields runs Edit Fields; Export
to Google Sheets contains native Google Sheets create/append nodes. Setup keeps
Google inactive and unapproved until its OAuth credential is connected. The owned
instance now has a connected credential and an active, pinned export KA. Google
writes additionally require the private operator export
key at the preview bridge; the public kit login alone cannot authorize them.

Real CSV parser execution `16` accepted BOM, quoted commas and an embedded
newline. Mapper execution `17` selected and renamed columns to `Name` and `Email`.
Their native private DKG executions are respectively
`urn:sr:execution:d8da0828-9f79-4450-a3fa-b6006a538326` and
`urn:sr:execution:b50ce40a-8c89-417c-85ce-dfc0c454bc34`. Exact completed replay
does not create another n8n execution. Malformed CSV returns a confirmed error;
duplicate mapping names are rejected before another n8n dispatch.

Parent Program `urn:demo:n8n:csv-pipeline:582172199c1a` composed the parser and
mapper through two approved `invoke_program` calls. Its execution is
`urn:sr:execution:7972a95b-3f9d-4474-98ca-714d38fbd1f3`, with child n8n executions
`19` and `20`. Parent and child receipts survived the subsequent service restart.

Google OAuth setup enabled Sheets and Drive APIs, added the PoC test user and
created a web client with the exact local n8n callback. The credential uses only
`drive.file`; n8n shows **Account connected**. Billing settings and quotas were
not changed. Client secrets and OAuth tokens remain outside the repositories.

Google export KA `urn:demo:n8n:google-sheets-export:73c05deaa967` ran native n8n
create/append nodes in successful execution `23`. The new Sheet contains `Name`
and `Email`, with the two mapped synthetic rows also verified in Google Sheets.
Its private DKG execution is
`urn:sr:execution:b73459e1-cea8-42fa-8c88-85d5e2b6ea44`. The original invocation
was reconciled after a service rebuild/restart, and its completed retry returned
the same verified receipt, n8n execution and Sheet. No second Sheet was created.
The private evidence retains the Sheet ID and URL. Workflow revision hashes now
also distinguish local KA names, avoiding a collision with the disabled draft
when OAuth enables a new pinned workflow.

The authorized Cloudflare gateway now serves the CSV build. Loopback API checks
through the gateway verified catalog availability, existing parser/mapper receipt
replay, viewer denial, foreign-origin denial and blocked raw admin routes. This
is API evidence, without a new public or local browser visual check.

An additional Google receipt replay through the preview gateway was rejected by
automatic approval review because it would transmit the private export key over
loopback. That gateway write check remains unverified; direct KA export, receipt
readback, replay and refusal without the export key passed.

Both the first Google receipt and earlier preview invocation
`ea153e24-aac9-49b6-9217-ba7f19d43cf6` exposed the same timestamp comparison bug:
Oxigraph canonicalizes `.840Z` to `.84Z`, while the durable receipt retains its
original lexical form. Receipt comparison now removes only trailing fractional
zeroes from UTC `xsd:dateTime` literals, preserving sub-millisecond precision.
The native regression covers `.000Z`, `.840Z`, `.8401Z`, lost write/finalize
acknowledgements and SQLite reopen. Both original journals were retained and
reconciled. The earlier normalization receipt now completes and replays with
its original n8n execution `11`, without another n8n dispatch.

The live check exposed a pre-existing receipt-finalization issue: selecting an
executor's lane did not also select its signing author. Receipt finalization now
passes the approved executor as author. The native regression uses different
publisher/executor keys and verifies executor attribution.

The DKG Program editor's tool picker is unchanged: n8n grants are configured via
the SDK/operator path until the editor has a workflow-grant form. The PoC canvas
discovers and invokes the resulting KA.

## Self-service nOS workflow builder

The nOS builder reuses the existing draggable canvas and port connections with
the installed KA catalog. The user selects blocks, connects one path (up to eight
blocks), configures mapping/title, saves a version and runs it. Each save creates
a native private Program KA with `permitsProgram` links, generated TypeScript
composition and pinned owner-approved child operations. Layout/configuration are
retained with source; CSV/text is provided only at run time. Earlier compiler
formats remain readable, and engine/source revisions retain distinct identities.

The real-runtime verifier saved workflow
`urn:demo:nos:workflow:af073eb9-95ec-4731-a4ab-e204cb6309a6:75aec39dce9a127c1a6c`.
Parent execution `urn:sr:execution:015fecea-20f9-46cc-ab0c-49c7e7310a45`
invoked native n8n parser `31` and mapper `32` and returned the two mapped rows.
Parent and child outputs were independently read back from DKG. Repeated save
returned the same source revision, and repeated run retained the same n8n IDs.
Read-only n8n SQLite execution IDs prove that replay did not dispatch again.
Saved Programs were reopened after the service restart; the actual nOS client
also passed live save/list/source/run/confirmed-rejection response validation.

Invalid CSV produces a confirmed parent receipt with only the executed parser
child; no mapper is dispatched. Mapping/header validation likewise stops before
an invalid downstream call. Unknown outcomes keep the original request identity.
Viewer, foreign-account, foreign-origin and stale-pin writes are denied. Google
parents require the existing private export authorization at save and run; a
missing-key parent is refused before source or approval creation. A new composed
Google export has not been exercised with that private key; the earlier native
Google leaf export proof remains separate.

**View in DKG** retrieves live source and its revision from the owned fixture
node at `127.0.0.1:4631`, graph `n8n-capability-poc`, private Working Memory. The
example server hosts API routes; it does not serve a standalone node dashboard.
This confirms local KA storage and does not imply public-chain publication.

Validation for this addition: 11 backend compiler/service tests; 1,194 unique
console/integration tests across 148 files (the loopback sign-in suite was rerun
with socket permission); development/production bundle isolation; console
typecheck and changed-file ESLint. Browser security policy denied the builder
origin because of a saved user permission. Browser visual/drag verification is
outstanding; no alternate browser or screenshot workaround was used.

Private continuation/evidence: `workflow-builder-verification-v2.json`,
`workflow-builder-evidence-v2.json`, and the earlier retained verification and
evidence files. They preserve exact save definitions and invocation identities.

Hosted CI, integration review and production deployment remain separate. Both
changes are intended as draft PRs stacked on their respective dependency PRs.
An optional replacement of the local n8n API key was rejected by automatic
approval review; no replacement was created and the original isolated test
credential remains in use.
