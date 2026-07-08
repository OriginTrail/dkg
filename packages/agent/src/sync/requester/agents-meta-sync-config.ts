// 2026-07-08 sync-storm mitigation (Chunk 1) — resolve whether durable sync
// should FETCH the system `agents/_meta` graph. Extracted as a pure function so
// both the CLI daemon lifecycle and the in-agent lifecycle resolve the flag
// identically, and so the precedence can be unit-tested in isolation.

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
