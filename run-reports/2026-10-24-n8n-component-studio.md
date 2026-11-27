# Native n8n component KA Studio PoC

The package adds thirty component KAs and a native graph compiler to the owned
local PoC. Implementation commits: DKG `2725ac1f3a9eddce722d0b0509c967342423cead`
and nOS `ec5ec8787769258be82f6d71fbbd348cd264eb34`. Both are on their existing
draft PR branches (#3446 and OriginTrail/tl-nos#1040), stacked on #3427 and Ziga's
OriginTrail/tl-nos#934 respectively. The latest fetched `testnet-canary` before
final validation remained `556ad8d4835278b85ddc17ee140d6fa900ba396e`.

## Installed state

- Official local n8n CLI imported thirty native templates and an echo helper.
  A consistent private SQLite backup preceded installation.
- All five earlier n8n workflow IDs, names, active flags and published-version
  IDs were read back unchanged. The real installation contains 36 workflows,
  33 published. No Google export runs during service startup.
- The actual DKG startup inventory returned 34 capability Programs: four
  retained capabilities plus thirty new component KAs, with 29 native bindings
  available. Drive has no OAuth connection and stays explicitly unavailable.
- KAs and receipts reside in private Working Memory on local node 4631, graph
  `n8n-capability-poc`, using MockChainAdapter. These are not public-chain assets.
- Existing CSV composition and its immutable v1/v2 source readers remain.
  Advanced graphs use native n8n scheduling with a parent DKG receipt and native
  per-block trace. They do not produce a child Program receipt for every block.

## Validation

- 27 credential-free component actions ran in a separate real n8n instance.
  The first ten data components passed as provider executions 1–10. Successful
  remaining component proofs used executions 12, 14–24 and 26–30. Stop And Error
  was an expected native rejection. Google-connected state was not used.
- Four real compiled graphs passed: branch (36), file parsing/renaming/export
  (37), loop/body/aggregation (38), and Schedule-root action input (39).
- A real native timer execution (95) contained its bound trigger scope and no
  downstream action node. Timers emit events; the DKG Program authorizes the
  separate action execution. The isolated fixture was stopped after validation.
- A real Wasm guest compiled and executed the generated Edit Fields Program,
  validated its input and issued exactly one stubbed host tool call. This was
  sandbox validation, not another provider/API invocation.
- 25 Node compiler/service/contract tests and 21 CLI adapter regressions passed.
  Coverage includes native ports/sinks, literal escaping, loop validation, child
  pins, revocation, no-repeat durable continuation, lost create acknowledgement,
  activation identity, webhook input conflicts and Google authorization.
- nOS console/integration coverage totals 1,209 passed tests across 150 files
  (the loopback identity suite ran separately after sandbox port binding failed).
  Nine new tests cover Studio contracts, exact receipts, four outputs/two inputs,
  malformed result rendering, safe URLs and the server-rendered shell.
- TypeScript builds/typecheck, changed-file ESLint/formatting, DKG root lint,
  diff checks and development/production bundle isolation passed.

## Remaining verification boundaries

Google Drive requires a separate operator connection. The new Sheets wrapper
reuses the existing connected native credential; this extension did not dispatch
another live Google export. Earlier Google create/append proof and the later
user-triggered CSV run (38/39/40) belong to the retained workflow path.

Automated browser access to the console remains blocked by a saved permission.
The earlier automatic approval rejection of authenticated preview-gateway checks
was not retried or bypassed. Live Studio save/run through the public UI and
gateway remain unverified; provisioning/service behavior is covered by mocks,
while compiled graphs and component execution were checked in real credential-free
n8n fixtures. A development preview build is provided for user interaction.
