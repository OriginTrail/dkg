/** A request started before the cutoff is not evidence of completion before it. */
export async function observeRestartRecoveryPoll(read, deadline, now = Date.now) {
  const requestStartedAt = new Date(now()).toISOString();
  const values = await read();
  const completedAt = now();
  const succeededBeforeDeadline = completedAt <= deadline && values.job?.state === 'succeeded'
    && values.descriptor.status === 200 && values.catalog?.appliedRowCount === '437'
    && values.catalog?.legacyReadOnlyCount === 0;
  return { requestStartedAt, at: new Date(completedAt).toISOString(), ...values,
    completedWithinDeadline: completedAt <= deadline, succeededBeforeDeadline };
}
