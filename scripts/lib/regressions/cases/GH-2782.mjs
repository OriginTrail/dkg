export default Object.freeze({
  caseId: 'GH-2782', file: 'packages/agent/test/regression-on-demand-cursor.test.ts',
  definitionFile: 'scripts/lib/regressions/cases/GH-2782.mjs',
  title: 'advances an on-demand subscription through its pending ordinals without a durable write',
  suite: 'VM reconcile cursor follows the subscription lifetime',
  assertion: 'GH-2782: unsaved subscription converges without durable membership',
  badObservation: (value) => typeof value.error === 'string'
    && /durable subscription intent or host state is missing/.test(value.error)
    && value.current === false && value.subscriptionWatermark === 0
    && value.saves === 0 && value.rows === 0 && value.sameSubscription === true,
});
