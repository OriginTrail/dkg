# PR #3836 native input admission and review coverage

Starting head: `73e1d28b5764f1a393701105a767196b971d898e`.
This addresses the six inline findings beginning at discussion 4540900931 and
the two corroborated blockers in Jurij's review 5862612384.

## Behavior

- New named-input workflows use compiler 8. An `Admit arguments` native node
  validates the complete pinned interface before the first component, including
  dispatches from independently approved Programs. Every parameter/data binding
  reads the admitted values, including optional defaults. Bounds, required data
  fields, unknown arguments and nonliteral values cannot bypass this admission.
- Composition admission normalizes native parameters before expanding the
  authoring graph. Mixed native/reusable saves can omit defaults, including a
  parameter targeted by a named input. Save/reopen/run and strict snapshot-tamper
  rejection are covered without changing recipe pins or mutating the request.
- Named-input guest revisions are frozen source artifacts. Compiler-6 parameter
  and data helpers, compiler-7 entry helpers and old source snapshots retain their
  bytes. Host function serialization is poisoned in regression tests to prove
  independence. Compiler 8 uses an explicit native-compatible helper revision:
  literal braces are escaped for n8n's parser, and the admitted record uses `values`
  because n8n prohibits accessing an `arguments` property.
- Unused document/library parser switches and adapter metadata were removed from
  this native-only contracts package. Native drafts, recipes and compositions
  retain their parsing boundaries; application adapter graphs are rejected.
- MCP coverage now retries the same run key with an omitted default supplied
  explicitly, asserting one dispatch; changed normalized values conflict.
- Switch data-field coverage executes the saved Program before native expressions.
  Invalid types, missing fields, overlong strings and expressions cause no tool call.

## Verification

- Final `pnpm test:studio`: all 58 contract and 513 Studio tests passed. The
  signed Studio authority/fingerprint suite passed all 16 cases, including the 35-second
  callback and canceled/crashed recovery. After final native-compatible guest
  adjustments, the compiler-8 signed replay/reopen case passed again separately.
- CLI TypeScript build, fingerprint check, lint and file-size audit passed.
- `verify-studio-arguments-native.mjs` uses the actual n8n 2.43.8 expression
  engine without services or credentials. Two valid/defaulted cases passed;
  four invalid cases produced no admitted record. Run it with the installed n8n
  package directory as its sole argument, under the engine's supported Node version.
- A temporary real workflow on the isolated local n8n instance received raw
  webhook packets, bypassing the generated Program and host service validation.
  Executions 11 and 12 succeeded with omitted/defaulted and explicit counts.
  Executions 13–16 failed for narrowed bounds, missing required data, extra fields
  and nonliteral input. All four failed at admission with zero component nodes run.
  Native digest: `22ed81165f14e579929ad99d065e57d1096a80f88416a391c2c369091e663375`.
  The temporary workflow was removed; existing FAIR workflows were preserved.

The native HTTP smoke used the existing isolated loopback fixture. It did not
exercise an independently signed Program through a live deployed nOS/MCP chain;
the signed-runtime tests use provider and DKG transport fixtures. Broader deployed
nOS composition/manual/MCP/lost-response qualification remains outstanding.
Old immutable native workflows are not rewritten: save a new compiler-8 revision
to install native argument admission. This report is not a merge or deployment claim.
