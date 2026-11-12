# PR #3836 review corrections — 2026-11-11

Reviewed starting head `d38c37694e57341b7f3624d8d88a035973836836` against
`codex/n8n-capability-poc`. All four findings from review 5860619421 were
reproduced and corrected in an independent worktree. The existing nOS checkout
and running FAIR workflows were not rebuilt or modified.

## Corrections

- The CLI development dependency closure now builds the private Studio
  contracts package. Both consuming integration lanes trigger on contract and
  Studio changes; Graph Runtime integration also runs `pnpm test:studio`.
- Both checked-in n8n implementation digests were regenerated after the lockfile
  update. Historical receipt evidence is unchanged.
- The shared capability parser accepts existing `urn:demo:n8n:component:` and
  `urn:nos:component:` identities. Tests parse actual native bridge, published
  reusable and Program inventory entries, and reject unsupported prefixes.
- Compiler 7 validates effective entry rows after fixed and named data bindings
  in host admission and the generated Program. It retains the original rows and
  canonical arguments in the journal; the native guard applies bindings once.
  Compiler 6 fixture source bytes and KA/native pins remain unchanged. Manual
  and MCP admission use the same validation helper.

## Local checks

macOS arm64; Node 26.8.2 for runtime tests, Node 22.23.2 for lint.

- Frozen dependency installation and a fresh Wasm runtime build passed.
- The exact dependency build used by both failed integration jobs passed without
  preexisting `dist` output:
  `pnpm -r --filter '@origintrail-official/dkg...' --filter '!@origintrail-official/dkg-evm-module' exec tsc`.
- `pnpm test:studio`: 57 contract and 509 Studio tests passed. The new entry-input
  suite additionally passed after adding explicit MCP/manual packet equivalence
  and invalid-file checks.
- The combined CLI test selection from Graph Runtime and Native LLM integration
  passed all 514 tests in 17 files, including fingerprints, authority changes,
  the 35-second callback and lost-response recovery (805 seconds, one worker).
- Signed compiler-7 invocation, runtime/journal reopen, identical replay and
  conflicting-argument rejection passed against the actual SDK/API, Wasm runtime
  and SQLite journal. The provider and DKG transport in that suite are fixtures.
- Native LLM: 229 tests; MCP adapters: 3; Graph Viz: 350; all passed.
  Graph Viz typecheck/build also passed.
- Query: 1,521 passed, three subprocess timeout failures under concurrent load.
  The complete affected ReDoS file passed all 18 tests on its isolated rerun,
  without changing timeout bounds or query code. The initial full run was not
  wholly green.
- Lint, file-size audit, all eight runtime build-plan checks and the implementation
  fingerprint generator's `--check` passed.

## Live native file-binding smoke

A temporary workflow was installed on the already isolated local n8n instance.
The new compiler generated an Extract File CSV entry with a required named JSON
`file` binding. Host admission accepted `itemsJson: "[{}]"` and two different
file arguments. Real native executions 6 and 7 succeeded, returning respectively
`{"name":"alpha","value":"42"}` and `{"name":"beta","value":"42"}`.
Both used workflow digest
`735cbcbab805ab69477601f9f1e787e8c02f5919c10a0f5c2763a9e2c875a528`.
The temporary workflow was removed afterward; both existing FAIR workflows
remained active. This direct native smoke did not run through signed SDK/MCP
transport and is separate from the signed-runtime regression above.

## CI and scope

The old Graph Runtime/LLM failures contained missing contract artifacts; Graph
Runtime also reported stale implementation digests. The old MCP Ubuntu and
Windows failures occurred during runner provisioning (Ubuntu package mirror DNS
and WSL distribution download DNS), before product tests.

This report is local validation, not green hosted CI, full deployed nOS
qualification, or public-chain proof. The broader live composition/MCP/recovery
matrix requested in review remains distinct from this focused native smoke.
