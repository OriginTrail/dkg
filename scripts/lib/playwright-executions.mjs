/** Read report structure once; consumers own retry and certification policy. */
export function* playwrightExecutions(suite, parents = []) {
  const titles = [...parents, suite.title].filter(Boolean);
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
    yield { file: spec.file, title: spec.title, id: spec.id,
      identity: [...titles, spec.title].join(' > '), project: test.projectName,
      expectedStatus: test.expectedStatus,
      attempts: (test.results ?? []).map(({ status, duration, startTime, retry }) => ({
        status, durationMs: duration, startTime, retry,
      })) };
  }
  for (const child of suite.suites ?? []) yield* playwrightExecutions(child, titles);
}
