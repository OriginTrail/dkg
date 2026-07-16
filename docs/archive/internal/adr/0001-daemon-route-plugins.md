# ADR 0001 — Daemon route plugins

- **Status:** Accepted
- **Date:** 2026-05-20
- **Deciders:** DKG core maintainers
- **Affected modules:** `packages/cli/src/daemon/{handle-request,lifecycle,config}.ts`,
  `packages/cli/src/daemon/{plugin-api,plugin-loader,routes/plugins}.ts`,
  `packages/cli/package.json`

## Context

DKG forks (Kamstrup, JPB, future) need to expose their own HTTP endpoints on
a DKG daemon — Kafka stream registration, domain-specific endpoints, future
protocol bindings. The only mechanism available before this change was to
edit `packages/cli/src/daemon/handle-request.ts` and insert a new dispatch
line into the route-group chain. That file changes upstream constantly, so
every fork sync produces a merge conflict on the line each fork added.
Forks either accept the recurring conflict cost or fall behind on upstream
security and feature work.

The pre-existing extension surface — `packages/cli/src/integrations/` (the
`dkg integration install` CLI) — is purpose-built to install trusted CLI
tools, MCP servers, Docker services, and ElizaOS Agent plugins from a
curated registry. It does not, and cannot, add HTTP routes to the running
daemon.

## Decision

Introduce a **route plugin** mechanism: an in-process extension point that
lets a fork contribute HTTP routes to the daemon without touching base-repo
files.

A route plugin is a module whose export is
`{ name: string, handle(ctx: RequestContext): Promise<void> | void }`. The
daemon loads every spec listed in `~/.dkg/config.json`'s `routePlugins`
array at startup, validates the export shape, and stores the loaded
plugins. A single, permanent dispatch step appended to the end of the
`handleRequest` route-group chain iterates the loaded plugins on every
request. The chain semantics the twelve built-in route groups already use
apply: writing to `ctx.res` claims the request; otherwise the next plugin
(and ultimately a `404`) gets a turn.

The base-repo file `handle-request.ts` is touched **once** to add the new
dispatch step, then expected to remain stable. From that point on, forks
add routes by publishing npm packages and editing their own operator
config, never by editing the base repo.

### Public API surface

The only public subpath exported from `@origintrail-official/dkg` is
`./daemon/plugin-api`, re-exporting:

- `RoutePlugin` interface
- `RequestContext` type
- `jsonResponse`, `readBody`, `readBodyBuffer`, `MAX_BODY_BYTES`,
  `SMALL_BODY_BYTES` helpers

Anything else in `packages/cli/src/` remains private and may change
without a semver-major bump.

### Behavioural guarantees

- **Loaded once at startup**, after agent/publisher/dashboard/vector-store
  initialization and before `server.listen()`.
- **Fail-soft loading.** A spec that fails to resolve, import, or
  validate is logged with the spec string and skipped; remaining plugins
  still load. The daemon boots.
- **Config-list dispatch order.** No alphabetic sort, no priority field.
  On path collisions the plugin earlier in the config wins.
- **Errors caught.** A plugin throwing mid-request is caught by the
  dispatcher. If the plugin has not already started a response, a
  `500 { error: 'PluginError', plugin, message }` is emitted. The chain
  stops; the daemon does not crash.
- **Auth inherited.** Plugins sit behind the global `httpAuthGuard`. They
  do not get to install per-plugin authentication.
- **CORS inherited** from the outer lifecycle wrapper.
- **Operator-state config.** `routePlugins` lives in `~/.dkg/config.json`
  so it survives `npm install -g @origintrail-official/dkg` upgrades.
- **Spec resolution.** Each entry in `routePlugins` is resolved by
  `importSpec` in `plugin-loader.ts`:
  1. **Absolute filesystem paths** (`isAbsolute(spec)`) are loaded
     directly via `import(pathToFileURL(spec).href)`.
  2. **Relative paths** (`./foo`, `../foo`) are **rejected** with a
     fail-soft warn. They would otherwise resolve relative to the
     loader's source file inside `packages/cli/dist/daemon/`, not
     relative to `~/.dkg/config.json` where the operator wrote them —
     a footgun that could silently import an unrelated daemon module.
  3. **Bare package names** (`@scope/pkg`, `pkg-name`) try the ESM
     resolver first (`await import(spec)`), which honours `import` and
     `default` conditions in the package's `exports` map. If ESM
     **resolution** fails because no `import` condition matches — e.g.
     for a CJS-only package whose `exports` declares only a `require`
     condition — fall back to
     `createRequire(import.meta.url).resolve(spec)` and re-import the
     resolved file URL. Node's dynamic import of a CJS file gives us
     `{ default: module.exports }`, which `pickCandidate` handles. ESM
     **runtime** failures — a `SyntaxError` in the ESM source, a
     missing transitive import, a rejected top-level `await` — are not
     rescued by CJS; the original error bubbles up through the
     fail-soft `route-plugin-load-failed` log so plugin authors see
     the broken build instead of getting a silent CJS sidestep.

  The loader's input type is `unknown`: a malformed `routePlugins`
  field (string, object, ...) is validated at the boundary, logged
  once, and treated as an empty array — so a typo cannot prevent the
  daemon from starting.

## Alternatives considered

### 1. Swap to Fastify / Express and use its native plugin system

Rejected. The daemon's HTTP stack is the Node `http.Server` and a
`handleRequest` chain that has been tuned across twelve route groups with
specific ordering, body-size limits, and a single global auth guard. A
framework swap is a months-long migration of every built-in route, with no
behavioural payoff for the plugin problem alone. Route plugins solve the
specific problem (fork-side route extension) without forcing the rewrite.

### 2. NPM provenance verification on plugin packages

Deferred to v2. The existing provenance verifier in `dkg integration`
requires an `expectedRepo` URL from a curated registry. Route plugins have
no registry — they are fork-owned packages. The current `routePlugins`
schema (`string[]`) is forward-compatible with a future
`(string | { package, version, expectedRepo })[]` form, so adding
provenance later does not break operators' string-form config.

### 3. Filesystem-scan plugin discovery

Rejected. Scanning `node_modules/**/package.json` for a `dkgRoutePlugin`
marker means every installed package becomes implicitly reachable at the
HTTP boundary. Explicit `routePlugins` config is the audit boundary — an
operator must opt each plugin in by name.

### 4. Per-plugin authentication surface

Rejected for this slice. The single global guard at `lifecycle.ts:1865`
remains the only authentication gate. A plugin cannot weaken or replace
it. If a future plugin needs delegated auth (e.g. a webhook with an
HMAC-signed body), that is a follow-up ADR.

### 5. Migrate `routes/epcis.ts` to a plugin immediately

Rejected as out of scope. EPCIS stays hard-coded as a chain step; the new
mechanism runs in parallel. Migration happens only when someone has
another reason to touch EPCIS. Doing both at once would couple
infrastructure validation to an EPCIS regression risk for no benefit.

### 6. Hot reload

Rejected. Restart the daemon to pick up plugin changes. Hot reload
introduces lifecycle bugs (in-flight requests, retained closures over old
plugin objects) for marginal operator convenience.

### 7. Startup conflict detection

Rejected. Plugins decide path ownership at runtime inside `handle()` —
there is no path manifest the loader can scan. First-config-listed wins,
documented in the README.

## Consequences

### Positive

- Fork maintainers stop merging upstream conflicts on
  `handle-request.ts`.
- The public API surface is one narrow subpath
  (`@origintrail-official/dkg/daemon/plugin-api`); other daemon internals
  remain private and changeable without semver pain.
- Plugins use the same helpers (`jsonResponse`, `readBody`) and the same
  `RequestContext` (with live `agent`, `publisherControl`, `config`,
  `dashDb`, etc.) as built-in routes, so plugin code looks like daemon
  code.
- Unit tests can drive a mock `ctx` against `handle()`; e2e tests can
  point `routePlugins` at a fixture path. No framework lock-in.

### Negative / accepted trade-offs

- Plugins run in-process. A long-running or memory-leaky `handle()` will
  degrade the daemon. Operators are responsible for the plugins they
  install.
- A misbehaving plugin can starve other plugins on the same path because
  dispatch is sequential and first-wins. Documented.
- The public contract (`plugin-api`) is now under semver discipline. We
  cannot rename `RequestContext` fields without a major bump.

### Future work

- v2 `routePlugins` schema accepting `{ package, version, expectedRepo }`
  for npm provenance verification.
- `createMockRequestContext()` helper for plugin authors' unit tests,
  once a few real plugins exist to inform the shape.
- Optional migration of `routes/epcis.ts` to a published plugin package.

## References

- PRD: `.orchestrator/runs/design-1779281500012672000/prd.md`
- Public surface tests: `packages/cli/test/daemon/plugin-loader.test.ts`,
  `packages/cli/test/daemon/routes/plugins.test.ts`,
  `packages/cli/test/daemon/plugin-routes-api.e2e.test.ts`
- README pointer: `packages/cli/README.md` → `### Route plugins`
