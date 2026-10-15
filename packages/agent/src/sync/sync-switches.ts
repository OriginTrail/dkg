/**
 * Environment and config switch resolution for the sync drivers: the
 * environment wins, then config, then the default. Re-exported by
 * `backpressure.ts`, where these resolvers were first defined.
 */

export function parseBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === 'enabled') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off' || raw === 'disabled') return false;
  return undefined;
}

export function resolveBooleanSwitch(
  configValue: boolean | undefined,
  envName: string,
  defaultValue: boolean,
): boolean {
  return parseBooleanEnv(envName) ?? configValue ?? defaultValue;
}

/** Effective activation of the periodic peer-sync reconciler (the timer that
 * re-syncs stale connected peers). Kept as one public resolver so runtime
 * gates and operator-facing status cannot disagree about
 * config/default/environment precedence. It does not gate chain-driven VM
 * reconciliation; see {@link resolveVmReconcilerEnabled}. */
export function resolveSyncReconcilerEnabled(configValue?: boolean): boolean {
  return resolveBooleanSwitch(
    configValue,
    'DKG_SYNC_RECONCILER_ENABLED',
    true,
  );
}

/** Effective activation of chain-driven VM reconciliation: core-hosted
 * recording, the KA-registered nudge, and the VM reconcile sweep. A core's
 * StorageACK finality gate keys off this switch, so a core with it off
 * declines every StorageACK. Same precedence as every other switch here:
 * environment, then config, then the default (on). */
export function resolveVmReconcilerEnabled(configValue?: boolean): boolean {
  return resolveBooleanSwitch(
    configValue,
    'DKG_VM_RECONCILER_ENABLED',
    true,
  );
}

/** Effective activation of the exact-batch stream wire: the requester on any
 * node and, on a core, the responder. Environment only; default off.
 * `DKG_EXPERIMENTAL_EXACT_BATCH_STREAM` is the name this switch was first
 * deployed under. It is read only when the current name is not set, so a node
 * configured before the rename keeps its setting. */
export function resolveExactBatchStreamEnabled(): boolean {
  return parseBooleanEnv('DKG_EXACT_BATCH_STREAM_ENABLED')
    ?? parseBooleanEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM')
    ?? false;
}

export function parseIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function positiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && typeof value === 'number' && value > 0 ? value : undefined;
}

export function nonNegativeInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 ? value : undefined;
}

export function resolvePositiveIntegerSwitch(
  configValue: number | undefined,
  envName: string,
): number | undefined {
  const value = parseIntegerEnv(envName) ?? configValue;
  if (value == null) return undefined;
  return positiveInteger(value);
}

export function resolveNonNegativeIntegerSwitch(
  configValue: number | undefined,
  envName: string,
): number | undefined {
  const value = parseIntegerEnv(envName) ?? configValue;
  if (value == null) return undefined;
  return nonNegativeInteger(value);
}
