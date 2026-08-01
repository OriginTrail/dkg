export const RFC64_M0_RECOVERY_SCENARIO_MANIFEST = Object.freeze([
  Object.freeze({
    id: 'cold-restart',
    rowId: 'automatic-cold-start-and-restart',
    label: 'Automatic cold start and restart',
    packageScript: 'test:rfc64-m0-recovery:cold-restart',
    title: 'automatically cold-joins a published public catalog and recovers it after restart',
  }),
  Object.freeze({
    id: 'provider-failover',
    rowId: 'source-recovery',
    label: 'Source recovery',
    packageScript: 'test:rfc64-m0-recovery:provider-failover',
    title: 'retries an initial miss and fails over to the later provider',
  }),
  Object.freeze({
    id: 'curated-parity',
    rowId: 'public-curated-cold-warm-parity',
    label: 'Public-curated cold/warm parity',
    packageScript: 'test:rfc64-m0-recovery:curated-parity',
    title: 'keeps warm and cold public-curated receivers at one exact finalized head across restart',
  }),
]);

export const RFC64_M0_RECOVERY_SCENARIOS = Object.freeze(
  RFC64_M0_RECOVERY_SCENARIO_MANIFEST.map(({ id }) => id),
);

export function getRfc64M0RecoveryScenario(scenarioId) {
  return RFC64_M0_RECOVERY_SCENARIO_MANIFEST.find(({ id }) => id === scenarioId) ?? null;
}
