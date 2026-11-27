# Graph Computer / Studio review fixes — 2026-11-09

The stack retains the concurrent recovery fixes pushed to #3446 and #3692 and
includes current `testnet-canary` at `3ebc303215`. No PR was merged.

| PR | Addressed behavior |
| --- | --- |
| #3427 | Native receipt and asset sealing explicitly use the approved executor as author. Asset readback shares exact RDF datetime comparison with receipts while retaining lexical input/journal identity. Native assertion, publisher, Oxigraph and SQLite restart regressions cover differing fallback wallet, interrupted effects, fractional timestamps, mismatched terms and revoked replay. |
| #3446 | Generic and Studio Google writes require export authorization before dispatch. A reserved fifth webhook/schedule event remains recoverable after restart; a sixth remains denied. Native continuation checks fence the reactivated execution, preserve revocation/expiry/epoch checks and inspect only acknowledged native effects. Legacy declared child pins remain authority checks; actual mixed Program traces cannot enter native-only continuation. New native wrappers use the versioned tool-only approval contract. |
| #3692 | DKG callbacks verify the published digest, execution version and structure while accepting n8n-normalized parameters. Existing approval/profile checks remain. Read/Write runtime recovery uses the same invocation and sealed effects after reopening the journal. Component inventory includes Merge Fields. Unreachable helpers were removed from the mapped demo Program without changing its exported calculation. |
| #3700 | The live DKG callback is correlated to the retained webhook acknowledgement, without requiring unavailable in-progress input data. Wrong execution/version/structure still fails; unknown acknowledgement stays unconfirmed. Withdrawal validates persisted pins independently of current profile eligibility and survives restart. TAP output, valid-loop rejection, real runner preflight and default-off agent HTTP coverage were corrected. |

## Local verification

- `pnpm exec tsc -b packages/cli`: passed.
- `pnpm lint`: passed, including the disabled-test audit (62 existing, zero additions).
- Native asset/Program/n8n tests: 79 passed; receipt lifecycle: 15 passed.
- Recovery cases: seven native continuation modes plus the Studio-produced
  Read/Write approval/restart case passed. Three initially timed out while other
  suites were running; all three passed together on an isolated rerun.
- `pnpm test:scripts` with Node 22.23.2/npm 10: 1,481 passed, two timing-sensitive
  failures outside these changes. Their isolated reruns passed (32 contention
  probe tests and the devnet cancellation case). The full run was not wholly green.
- The mapped demo's exported result/error behavior matched the previous source
  for five calculation/validation inputs after pruning unused helpers.
- Base red proof: nine new author/readback regressions failed with the old source
  and passed with the fix.

## Actual native MCP execution

On an isolated n8n 2.43.8 instance (engine Node 24.22.0), with
`EXECUTIONS_DATA_SAVE_ON_PROGRESS=false`, the smoke used real provisioning,
authenticated MCP HTTP admission, native webhook dispatch, the DKG callback and
terminal inspection. DKG transport used only the fictional measurement profile.

The previous callback failed the same smoke (native execution 2). The fix passed
again after incorporating the concurrent stack updates (execution 4): one POST,
one callback, one DKG read, absent in-progress `Receive input` evidence, the exact
two expected rows, preserved agent attribution and no redispatch on repetition.
The smoke waits for n8n webhook registration after publication. Reproduction is
documented in [STUDIO-MCP.md](../STUDIO-MCP.md#native-n8n-callback-regression).
The isolated engine was stopped afterward.

These results do not qualify a customer nOS gateway/DKG deployment or replace
the requested independent multi-node qualification. Hosted CI and renewed review
apply to the pushed heads separately.
