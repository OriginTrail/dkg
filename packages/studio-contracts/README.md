# Studio contracts

Private workspace package for the Studio wire contract ported from nOS #1300.
It owns the graph, reusable recipe and named invocation input models used by
`examples/n8n-capability`. The package has no dependency on the nOS application,
control plane, browser or deployment launcher.

- `studio-input-schema` defines `StudioComponentInput`: name, label, description,
  required/default/type constraints, and one or more target fields.
- `studio-inputs` validates arguments, resolves target parameters, generates the
  tool JSON schema and emits the trusted validation helper in a Program KA.
- `studio-composition` parses export requests/recipes and expands exact pinned
  reusable components. Expansion retains invocation bindings and output ports.
- `studio-evidence` distinguishes compact authoring graphs from saved execution
  definitions with their composition snapshots.

The input/output interface limits remain 1024. Existing native graph, request,
parameter and serialized-source budgets are separate admission constraints.
The DKG parser also accepts the existing `urn:demo:n8n:component:` identities;
existing installed components do not need new pins to participate in recipes.

Build with `pnpm --filter @origintrail-official/dkg-studio-contracts build`, or
through `pnpm build:runtime:packages`. Run the complete Studio regression lane
with `pnpm test:studio` after building the runtime dependencies.

The initial source is carried from nOS commit `f7c572917bbb9c620e1de1677fa16d39b4a577c7`.
This upstream port deliberately leaves that application and its overlay intact.
A subsequent nOS dependency update can consume the reviewed DKG implementation.
