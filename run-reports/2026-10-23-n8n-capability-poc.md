# n8n capability KA PoC - local verification

Date: 23 October 2026. The DKG branch starts from Graph Computer PR #3427 at
`6bf4c9c38756cc77f0c39e523975f54d45c31c95` and includes freshly fetched
`origin/testnet-canary` at `f9b5f2524ed6052c7126ddd940e6d05ea5a77549`.
The companion nOS change starts from Ziga's PR #934 at
`4f0dd2eb9d4fb4c61ca0e603640821ef84e7fd16`.

## Runtime evidence

- DKG Node 26.8.2; separate n8n 2.43.8 / Node 24.22.0; nOS Node 22.23.2 / pnpm 11.22.0.
- Real DKGAgent, persistent Oxigraph, native KA create/write/finalize, persistent KA allocator, signed HTTP authentication and nonce storage, real Wasm TypeScript Program execution, SQLite effect and receipt journals.
- Local chain boundary: MockChainAdapter. Private Working Memory; no on-chain transactions or public publication.
- Agent invokes Program KA `urn:demo:n8n:normalize-text:1`, receives `HELLO DKG`, and reads back the matching execution KA. Completed retry keeps the same n8n execution ID.
- A parent Program KA invokes the child through `invoke_program`, returns `COMPOSED DKG` and records both execution references. Its completed retry also keeps the same result.
- Browser verification: existing nOS Network canvas discovers the capability from DKG, invokes it, and shows the real result, n8n execution ID and verified private DKG readback.
- Live regression script confirms no additional n8n executions for completed replay, invalid input, an unauthorized signed caller, viewer/foreign-account requests, a stale KA source hash and a changed published workflow. The owned workflow is restored after the mismatch check.
- The DKG service was stopped and restarted against its persisted node/runtime state; stored Program, approval and execution state remained usable.

Private node homes, credentials, provider history and runtime logs remain outside
the repository. The reproducible scripts write `evidence.json`,
`regression-evidence.json` and `composition-evidence.json` into the chosen local
state directory. They contain execution references and non-secret evidence.

## Validation

| Check | Result |
| --- | --- |
| DKG affected CLI approval, invocation, runtime, adapter and native receipt suites | 239/239 pass, 6 files |
| Graph Computer SDK | 37/37 pass, 3 files |
| CLI build and type tests; semantic-runtime TypeScript build | Pass |
| nOS console, console integration and development/production bundle boundary | 1178/1178 pass, 147 files |
| nOS console typecheck, production build and changed-file ESLint | Pass |
| Real n8n / DKG invocation, composition, readback, replay and denial checks | Pass |

The live check exposed a pre-existing receipt-finalization issue: selecting an
executor's lane did not also select its signing author. Receipt finalization now
passes the approved executor as author. The native regression uses different
publisher/executor keys and verifies executor attribution.

Hosted CI, integration review and production deployment remain separate. Both
changes are intended as draft PRs stacked on their respective dependency PRs.
An optional replacement of the local n8n API key was rejected by automatic
approval review; no replacement was created and the original isolated test
credential remains in use.
