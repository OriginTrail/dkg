# Generic HTTP inputs and nested mapping

The HTTP Request KA now accepts a workflow-configured public HTTPS URL,
method, query object, headers and arbitrary JSON body. Query/header/body values
can reference input fields. Edit Fields resolves nested data paths and array
indexes while retaining JSON types and can omit other input fields. These are
native HTTP Request and Set nodes; no replacement HTTP/data execution engine was added.

The nOS inspector exposes named field rows and input-path controls, with advanced
JSON available. Its **HTTP → temperature** preset contains the user's complete
Open-Meteo URL followed by three mappings for temperature, unit and observation time.

Validation on 2026-10-24:

- Real credential-free n8n graph executions **96** and **97** succeeded. The first
  used the complete URL including all hourly variables. The second configured the
  base URL, input-derived latitude/longitude query values and a custom header.
  Both returned `temperature: 11.6`, `unit: "°C"`, `time: "2026-10-24T09:30"`;
  the second also resolved `hourly.temperature_2m[0]` to numeric `11.3`.
- 28 compiler, contract, mapping and saved-workflow service tests passed.
- The actual Wasm guest compiled and ran the generated HTTP Program with one
  stub tool dispatch, accepted a public URL and rejected a private URL before dispatch.
- The installed n8n SSRF service rejected mocked DNS answers for loopback,
  private IPv4, link-local metadata and IPv6 loopback (no network calls).
- Companion UI: 149 console/integration suites passed in the broad run; the
  identity suite was initially blocked from binding its loopback fixture and all
  18 tests then passed with the required permission. Together this covers all
  1,210 console/integration tests. Typecheck, changed-file lint/format and
  production/development bundle isolation passed.
- The owned PoC was updated using n8n's local CLI after a SQLite backup. It is
  ready with 30 current component KAs, 29 configured, plus two retired component
  revisions for existing saved graphs. Both revised leaf grants are approved.
  The n8n process now has SSRF protection enabled; redirects stay disabled.
- The preview development build was installed at the existing public origin.
  Page and new JavaScript asset HEAD requests returned HTTP 200.

Compiler version two has a distinct identity. Frozen version-one modules retain
the original source validator and component pins for previously saved workflows.
The latest revisions appear in the new-block palette; older blocks can be upgraded
explicitly. The original fixed local HTTP demo cannot execute with SSRF enabled.

Boundary: native HTTP/mapping execution was proved against an isolated,
credential-free real n8n instance. Browser automation and authenticated public
gateway checks remain unavailable under existing tool permissions, so the live
UI save/run path is not claimed as independently verified. No Google export or
on-chain publication was performed.

Reproduction uses `verify-http-mapping-native.mjs --prepare` in the isolated
fixture state, local n8n CLI import/publication, a loopback fixture n8n server with
`N8N_SSRF_PROTECTION_ENABLED=true`, then the same verifier without `--prepare`.
