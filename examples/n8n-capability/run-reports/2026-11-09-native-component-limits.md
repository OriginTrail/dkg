# Standalone component limits at the native boundary

Addresses #3446 review thread 4518163371. A separately approved Program could
call `invoke_tool` with the installed component grant while omitting its supplied
validation wrapper. One hundred small file records fit the wire schema's 8,192
character limit and reached the upload action before output collection rejected
the oversized result.

`Prepare input` now embeds the existing frozen component validator in the pinned
native definition. It checks the entire decoded batch and parameters before
`Split input`, binary conversion or any component action. Action parameters come
from that validated, default-filled result. Guest source artifacts are unchanged.

The existing content-derived installer produces new immutable workflow IDs,
workflow hashes and component references for all 29 callable components in #3446.
The operator-configured schedule definition is unchanged. Old definitions and
saved references remain available through the installer's retired-revision path;
operators must install and approve the new revisions to obtain this protection.

## Regression evidence

- Twelve of thirteen new native-expression tests failed before the change. They
  now cover the decoded record limit, defaults, invalid parameters, reserved
  fields, malformed/file input, Sheets shape, HTTP destinations and expressions.
- A signed runtime test approves both the supplied wrapper and a separate Program
  with the same installed grant. The latter calls `invoke_tool` directly. Before
  the fix its mocked upload counter reached 100; afterward it stays zero and the
  receipt reports rejection. Twenty valid files still reach the mocked upload.
  This exercises real approval, guest execution and the adapter, with provider
  transport and uploads simulated.
- Separately, an isolated n8n 2.43.8 on Node 24.22.0 imported and published new
  Google Drive, Limit and HTTP fixture revisions. Actual executions 1–5 rejected
  100 files, an invalid last file, an invalid Drive parameter, an out-of-range
  Limit parameter and a private HTTP destination in `Prepare input`. None reached
  `Split input` or a component node. Execution 6 accepted twenty valid records and
  used Limit's default parameter successfully. The fixture used no Google
  credentials, partner data or production services and was stopped afterward.

The new tests run in the existing script and CLI unit lanes. Local validation
does not establish hosted CI, independent review or deployment approval.
