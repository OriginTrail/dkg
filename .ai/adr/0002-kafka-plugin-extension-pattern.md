# ADR 0002 — kafka-plugin extension pattern

- **Status:** Accepted
- **Date:** 2026-05-24
- **Deciders:** DKG core maintainers (kafka-plugin slice authors + reviewer)
- **Affected modules:** `packages/kafka-plugin/src/{extension,handler,index,ka-builder}.ts`,
  `packages/cli/test-fixtures/sample-kafka-{plugin,extension}/dist/index.js`,
  `packages/kafka-plugin/test/{extension-merge,handler,kafka-plugin-api.e2e}.test.ts`

## Context

Forks consuming `@origintrail-official/kafka-plugin` need a way to add
domain-specific fields (`tenantId`, `deviceId`, `meterModel`, fork-owned
ontology pointers) to the published KA without re-implementing the
publish/poll machinery, schema validation, error vocabulary, or
discovery endpoints.

Whatever shape we expose becomes load-bearing for every fork's adapter
package. Three concrete pressures bound the choice:

1. **Type safety.** Forks write TypeScript. If they declare extra fields
   as `Record<string, unknown>` and validate at runtime with hand-rolled
   conditionals, every fork drifts in error-message wording and missed
   edge cases.
2. **Single validation pass.** Validating core in the plugin, then
   re-parsing extension fields inside the augment callback, duplicates
   the JSON parse and produces split error responses (some Zod-shaped,
   some hand-shaped). Operators correlating logs across forks see
   inconsistent vocabularies.
3. **Cross-fork discoverability.** Whatever fields a fork adds MUST NOT
   silently override core `dkg-streams:*` properties or the invariant
   `@type: dkg-streams:KafkaStream` — otherwise federated SPARQL queries
   miss the fork's KAs (the Slice 2 PRD's headline guarantee).

## Decision

The extension surface is a single interface:

```ts
interface KafkaPluginExtension<TParsed> {
  schema: ZodSchema<TParsed>;
  augment: (parsed: TParsed) => Record<string, unknown>;
}
```

passed via `createKafkaPlugin({ extension })`. The plugin:

1. **Boot-time guards** the extension at factory call: `Object.keys(extension.schema.shape)`
   intersected with `Object.keys(coreSchema.shape)` must be empty.
   Overlap throws `ExtensionSchemaCollisionError` listing every
   offending key. The fail-soft `route-plugin-load-failed` channel
   surfaces the throw so the daemon boots; only the broken plugin is
   skipped.
2. **Merges schemas at construction** (`coreSchema.merge(extension.schema).strict()`)
   and validates the whole request body in one `parseAsync` call. A
   single 400 `InvalidContent` with flattened Zod issues covers core +
   extension errors identically.
3. **Calls `augment(parsedExtensionFieldsOnly)`** after the merged
   parse; the returned object is shallow-merged into the base KA via
   `mergeAugmentFragment`. Core keys always win on collision; the first
   occurrence of each unique dropped key emits one `console.warn` per
   plugin instance (tracked via a shared `Set<string>`).

## Alternatives considered

### 1. Function-based DTO validation (no Zod)

Reject. The plugin would expose `validate(body): { ok, fields, errors }`
plus `augment(fields)`. Forks would hand-roll the validation. Two
losses:

- Error shape drift across forks (item 2 above) — Zod's flattened-issues
  format is the lingua franca the daemon already uses, swapping it for
  a hand format orphans the kafka-plugin from the rest of the daemon's
  validation responses.
- No TypeScript inference. Forks lose `TParsed` flowing into `augment`,
  meaning every adapter re-types the fields manually.

The "single-pass parse" benefit (item 2) is also lost — call sites would
need a separate JSON.parse + ad-hoc field extraction.

### 2. Path C only — no extension API; forks fork the plugin

Reject. The PRD's user-stories #6 and #12 specifically ask for a thin
adapter shape ("publish a thin npm package that calls `createKafkaPlugin({ extension })`")
so fork maintainers don't carry a forked plugin tree through every
upstream sync. Forcing Path C makes ADR 0001 + Slice 2 a half-fix:
forks would still merge-conflict on every `kafka-plugin` upstream
change just as they did on `handle-request.ts` before route plugins.

### 3. Bare HTTP wrapper (forks own the whole endpoint, plugin just exports helpers)

Reject. Same problem as #2 from a different angle — forks would
re-implement POST/poll/GET-list/GET-by-UAL each time, and the publish
options surface (`{ public }` envelope wrap, capture-async lifecycle,
SPARQL discovery) would drift. The PRD calls this out as the failure
mode the slice exists to prevent ("every fork that needs Kafka stream
registration writes the same plumbing from scratch").

### 4. Zod `.deepmerge` instead of `.merge` + boot-time collision check

Reject. `deepmerge` does not exist in Zod 3; the closest is `extend`
which has right-wins semantics (a colliding extension key would silently
override the core validator). The boot-time intersection check makes
the collision a load-time fatal, not a silent runtime narrowing.

## Consequences

### Positive

- Forks write ~10 lines: a Zod schema, an augment callback, and a
  `createKafkaPlugin({ extension })` re-export.
- One Zod schema is the single source of truth for both validation and
  type inference. Errors flow through the existing 400 `InvalidContent`
  path.
- Cross-fork SPARQL queries on `?s a dkg-streams:KafkaStream` keep
  working — the boot-time guard prevents schema-level core erosion, and
  the runtime core-wins rule prevents KA-level core erosion.

### Negative / accepted trade-offs

- The runtime core-wins drop is silent after the first log. A
  misconfigured `augment` that consistently emits a colliding key
  drops it on every request; the operator sees one warn then nothing.
  Acceptable because the boot-time check catches the structural case;
  the runtime check only fires when `augment` is computed dynamically
  (e.g. derived from request data) and produces an unlucky key.
- The extension's `TParsed` type does NOT include core fields, even
  though the merged schema accepts them in the same body. `augment`
  intentionally receives only the extension's own fields so an
  extension cannot rewrite or override core values — keep the core/
  extension contract surface narrow.

### Future work

- `afterPublish` and `onFinalized` extension hooks (deferred — see
  Slice 2 PRD's "Deferred surfaces"); the current interface keeps the
  plugin observable only at HTTP boundaries.
- Strongly-typed augment fragment (`augment: (parsed) => JsonLdFragment`)
  once the fragment schema is stable enough to lock.

## References

- PRD: `.orchestrator/runs/design-1779556342637217000/prd.md` —
  "Implementation Decisions" → "Public API" / "Collision rules"
- Source: `packages/kafka-plugin/src/extension.ts`,
  `packages/kafka-plugin/src/handler.ts` (POST `/register` body parse +
  augment merge)
- Tests: `packages/kafka-plugin/test/extension-merge.test.ts`,
  `packages/kafka-plugin/test/handler.test.ts`,
  `packages/kafka-plugin/test/kafka-plugin-api.e2e.test.ts`
- Glossary: `packages/kafka-plugin/CONTEXT.md` → **Extension**
