import { CI_LANE_TOPOLOGY, COVERAGE_JOBS } from './ci-lanes.mjs';

/** Check generic workflow boundaries; package membership and shard counts are never mirrored here. */
export function validateCiLaneWorkflow(workflow) {
  const fail = (message) => { throw new Error(`CI lane topology: ${message}`); };
  const build = workflow.jobs?.build;
  if (build?.outputs?.test_matrices !== '${{ steps.test-matrices.outputs.matrices }}' ||
      !build.steps.some((step) => step.id === 'test-matrices' && step.run === 'node scripts/ci/emit-test-matrices.mjs')) fail('build must emit canonical matrices');
  for (const [lane, { job: jobId, groups }] of Object.entries(CI_LANE_TOPOLOGY)) {
    const job = workflow.jobs?.[jobId];
    if (!job) fail(`missing job ${jobId}`);
    if (!String(job.if).includes(`needs.changes.outputs.${lane} == 'true'`)) fail(`${jobId} lost planner condition ${lane}`);
    if (!groups) continue;
    if (job.env?.DKG_CI_COVERAGE !== '1') fail(`${jobId} must collect coverage`);
    if (!workflow.jobs['coverage-results']?.needs?.includes(jobId)) fail(`${jobId} is missing from coverage aggregation`);
    const matrix = job.strategy?.matrix;
    const expectedMatrix = '${{ fromJSON(needs.build.outputs.test_matrices)[\'' + jobId + '\'] }}';
    if (matrix !== expectedMatrix) fail(`${jobId} must use the emitted matrix`);
    const command = 'node scripts/ci/run-vitest-lanes.mjs --job ${{ github.job }} --row ${{ matrix.row }}';
    const lines = job.steps.flatMap((step) => (step.run ?? '').split('\n'));
    if (!lines.some((line) => line.trim() === command || line.trim() === `${command} || status=$?`)) fail(`${jobId} must run the canonical row`);
    if (lines.some((line) => line.includes('run-vitest-junit.mjs'))) fail(`${jobId} must not duplicate package routing`);
  }
  const runners = Object.entries(workflow.jobs).filter(([, job]) => job.steps?.some((step) => /run-vitest-(?:junit|lanes)\.mjs/.test(step.run ?? ''))).map(([job]) => job).sort();
  if (JSON.stringify(runners) !== JSON.stringify(Object.keys(COVERAGE_JOBS).sort())) fail('workflow has an unregistered coverage runner');
}
