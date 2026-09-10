/**
 * Canonical doctor policy used before `dkg update` applies a release.
 * Kept separate from the doctor runtime so command registration stays light.
 */
export const ALL_CHECK_IDS = [
  'node-runtime',
  'orphan-repos',
  'config-sanity',
  'install-layout',
  'version-skew',
  'served-ui-mismatch',
  'plugin-root',
] as const;

export type CheckId = (typeof ALL_CHECK_IDS)[number];

export const UPDATE_PREFLIGHT_CHECKS = [
  'node-runtime',
  'install-layout',
  'version-skew',
] as const satisfies readonly CheckId[];
