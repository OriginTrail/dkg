/**
 * Canonical doctor policy used before `dkg update` applies a release.
 * Kept separate from the doctor runtime so command registration stays light.
 */
export const UPDATE_PREFLIGHT_CHECKS = ['install-layout', 'version-skew'] as const;
