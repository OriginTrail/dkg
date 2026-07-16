// Agents-registry `_meta` sync policy (#1233 sync-storm mitigation). Neutral home
// for BOTH sides of the agents/_meta bloat mitigation, so the dependency graph is
// honest — it is consumed by the requester FETCH path, the responder SERVE path,
// AND the CLI daemon lifecycle, and is owned by none of them:
//   - resolveSyncAgentsMeta          — FETCH-side opt-IN (should durable sync pull agents/_meta?)
//   - shouldWithholdAgentsDurableMeta — SERVE-side opt-OUT (should the responder withhold it?)
// Both are pure functions (env passed IN, never read here) so the precedence is
// unit-testable in isolation and neither the responder nor the requester carries
// daemon config policy. The daemon lifecycle builds the responder's serve-skip
// predicate inline by calling `shouldWithholdAgentsDurableMeta` directly with a fresh
// `process.env.DKG_SERVE_AGENTS_META` read at its wiring boundary.

import { isAgentRegistryContextGraph } from '@origintrail-official/dkg-core';

/**
 * Parse a boolean-ish environment string into a strict boolean, or `undefined`
 * when the value is absent / unrecognized (so callers can fall through to a
 * default). Recognizes the usual on/off spellings; unknown values are treated
 * as "unset" rather than silently truthy.
 */
export function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return undefined;
}

/**
 * Resolve whether durable sync should fetch the system `agents/_meta` graph.
 *
 * The `agents` system context-graph `_meta` is bloated (per-heartbeat KA/KC
 * lifecycle records) and has no cross-node consumer, yet it was previously
 * force-synced on every core node — a hot contributor to the mainnet
 * sync-retry storm. It is now opt-IN on every role: fetch only when the
 * operator asks for it.
 *
 * Precedence (first defined wins):
 *   1. explicit config value (`config.syncAgentsMeta`)
 *   2. `DKG_SYNC_AGENTS_META` env (`1`/`true`/`on`/`yes` ⇒ true; `0`/`false`/… ⇒ false)
 *   3. default `false` (do NOT fetch)
 *
 * The result is ALWAYS a strict boolean so the requester-side skip in
 * `runDurableSync` — which fires only on `syncAgentsMeta === false` — can
 * trigger. This governs the `_meta` graph only; the `agents` DATA graph (the
 * peer phonebook) is always synced regardless of this flag.
 */
export function resolveSyncAgentsMeta(
  configValue: boolean | undefined,
  envValue: string | undefined,
): boolean {
  if (typeof configValue === 'boolean') return configValue;
  const fromEnv = parseBooleanEnv(envValue);
  if (fromEnv !== undefined) return fromEnv;
  return false;
}

/**
 * Resolve whether the sync RESPONDER should WITHHOLD the durable `agents/_meta`
 * snapshot from a requesting peer (#1233). This is the SERVE-side counterpart to
 * `resolveSyncAgentsMeta` (the FETCH-side skip): the agents `_meta` is bloated
 * (per-heartbeat KA/KC lifecycle records) and has no cross-node consumer, so a
 * core that keeps serving it merely re-propagates the bloat across the mesh.
 *
 * Kept as a pure function (env passed IN, not read here) so the responder stays
 * free of daemon config policy — the responder receives this as an injected
 * predicate — and so the precedence is unit-testable in isolation.
 *
 * Withhold when it's the agents registry CG AND the operator has NOT opted in to
 * serving it (`DKG_SERVE_AGENTS_META` truthy — `1`/`true`/`on`/`yes`). Any
 * non-agents CG is NEVER withheld. Callers pass `process.env.DKG_SERVE_AGENTS_META`
 * fresh on every request, so the kill-switch is reversible at runtime.
 */
export function shouldWithholdAgentsDurableMeta(
  contextGraphId: string,
  serveEnvValue: string | undefined,
): boolean {
  if (!isAgentRegistryContextGraph(contextGraphId)) return false;
  return parseBooleanEnv(serveEnvValue) !== true;
}
