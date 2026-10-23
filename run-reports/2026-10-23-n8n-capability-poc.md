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
`csv-composition-evidence.json` into the chosen local
state directory. They contain execution references and non-secret evidence.

## Validation

| Check | Result |
| --- | --- |
| DKG affected CLI approval, invocation, runtime, adapter and native receipt suites | 241/241 pass, 6 files; unit config |
| Graph Computer SDK | 37/37 pass, 3 files |
| CLI build and type tests; semantic-runtime TypeScript build | Pass |
| Agent build, type tests and package-root boundary after the canary merge | Pass |
| nOS console and console integration | 1184/1184 pass, 147 files |
| nOS development/production bundle boundary | 1/1 pass |
| nOS console typecheck, production build and changed-file ESLint | Pass |
| Real n8n / DKG invocation, composition, readback, replay and denial checks | Pass |
| DKG full runtime package build, repository lint and libp2p pin check | Pass |
| Google Sheets create/append against a connected account | Pending operator OAuth connection; no Sheet created |

## CSV extension

The approved extension uses three separate Program KAs. Parse CSV runs n8n's
Convert to File and Extract From File nodes; Map fields runs Edit Fields; Export
to Google Sheets contains native Google Sheets create/append nodes. Google is an
inactive n8n draft and an unavailable, unapproved KA until its OAuth credential
is connected. Google writes additionally require the private operator export
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

The authorized Cloudflare gateway now serves the CSV build. Loopback API checks
through the gateway verified catalog availability, existing parser/mapper receipt
replay, viewer denial, foreign-origin denial and blocked raw admin routes. This
is API evidence, without a new public or local browser visual check.

An earlier preview invocation, `ea153e24-aac9-49b6-9217-ba7f19d43cf6`, remains
blocked by `EXECUTION_LAYER_CONFLICT` after n8n execution `11`. Its original
journal is retained and its retry did not redispatch n8n. Later normalization
and all CSV proofs completed, but this unresolved earlier receipt conflict is
a draft limitation.

The live check exposed a pre-existing receipt-finalization issue: selecting an
executor's lane did not also select its signing author. Receipt finalization now
passes the approved executor as author. The native regression uses different
publisher/executor keys and verifies executor attribution.

The DKG Program editor's tool picker is unchanged: n8n grants are configured via
the SDK/operator path until the editor has a workflow-grant form. The PoC canvas
discovers and invokes the resulting KA.

Hosted CI, integration review and production deployment remain separate. Both
changes are intended as draft PRs stacked on their respective dependency PRs.
An optional replacement of the local n8n API key was rejected by automatic
approval review; no replacement was created and the original isolated test
credential remains in use.
