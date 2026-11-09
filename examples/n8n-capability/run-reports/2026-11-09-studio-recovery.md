# Studio callback and Read/Write recovery recheck — 2026-11-09

This change addresses the two execution findings and registry failure in #3692.
The native continuation and approval-contract fixes also belong in its base #3446.

## Regression and authorization evidence

- The old callback verifier rejects the generated Read/Write execution after
  expression-prefix normalization. The callback now uses the runtime's existing
  published-definition/version verifier. The approved digest still covers all
  source parameters; execution ID, workflow/version, graph structure, credentials,
  Program approval, profile revision and current owner remain checked.
- The old continuation captures `failed`, changes the execution to `active`, then
  rejects its own authority check. The fix updates that status expectation only
  when taking the existing acknowledged-native continuation path.
- Studio's actual compiler/save path now declares no unused child Program grants
  for native wrappers. Compiler contract 4 makes this a new immutable revision;
  old sources, approvals and pending identities are not rewritten.
- The signed API/TypeScript/Wasm test saves a Read → Write workflow through the
  real Studio service, loses native inspection after a simulated sealed node
  write, closes/reopens the runtime and companion SQLite stores, and resumes the
  original invocation. There is one webhook POST, one node write and one completed
  receipt; replay returns the same result. Changed input and native version,
  missing acknowledgement, attempted new work, revocation, expiry and epoch
  changes remain denied by the companion/runtime regression tests.
- The component registry contains 31 components; both stale count assertions now
  require 31, with per-component generation checks retained.

## Real native engine check

An isolated n8n **2.43.8**, running on Node **24.22.0**, executed the generated
Read → Write workflow to `success` (execution `1`). Both authenticated HTTP
callbacks reached the actual Studio service, and the fictional node transport
recorded exactly one Read and one sealed Write. The callback URL used a private
test port, rewritten before the published digest was approved. No Google,
partner node, production account or public-chain publication was used.

The credential-reference-redacted published definition and execution snapshot
are committed as `packages/cli/test/fixtures/n8n-2.43.8-studio-read-write.json`.
This engine run retained expression-leading `=` characters; the test additionally
normalizes a copied snapshot to exercise the reported failure, then rejects a
foreign credential and version. The live engine result and the restart regression
are separate evidence: the latter uses a simulated provider with the real runtime.
The isolated engine was stopped after capture.

## Validation

On macOS arm64 / Node **26.12.1**, with the locked workspace dependencies and
unchanged Wasm integrity artifacts:

- 68/68 example, component registry, Studio and retired-source tests passed.
- 145 selected native, receipt, authority and revocation runtime tests passed.
- All 30 native/legacy adapter and captured-fixture tests passed.
- Independently on the #3446 base: 13 Studio tests and all 6 native continuation
  scenarios passed, including authority invalidation across restart.
- CLI compile and type-contract checks passed; `git diff --check` passed.

Commands (from the repository root, except CLI commands):

```sh
node --test examples/n8n-capability/*.test.mjs scripts/lib/__tests__/n8n-components.test.mjs scripts/lib/__tests__/n8n-studio.test.mjs scripts/lib/__tests__/n8n-studio-retired.test.mjs
cd packages/cli
pnpm exec vitest run --config vitest.unit.config.ts test/semantic-runtime-n8n-native.test.ts test/semantic-runtime-n8n-adapter.test.ts test/semantic-runtime-configuration-api.test.ts -t 'native|Studio-produced|receipt|authority|revok'
pnpm exec vitest run --config vitest.unit.config.ts test/semantic-runtime-n8n-native.test.ts test/semantic-runtime-n8n-adapter.test.ts
pnpm run build:compile
pnpm run test:types
```

Root lint still reports three pre-existing unused declarations in
`jpb-plca-mapped.ts`. The disabled-test audit reports five expired platform-test
exception annotations in three existing test files (zero new findings). These checks, the other open #3427/#3446 review findings,
independent review and deployed qualification are not cleared by this evidence.
