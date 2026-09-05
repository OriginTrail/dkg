import { CI_LANE_TOPOLOGY, COVERAGE_JOBS } from './ci-lanes.mjs';

/** Validate executable workflow wiring against the model used by planning and receipt aggregation. */
export function validateCiLaneWorkflow(workflow) {
  const fail = (message) => { throw new Error(`CI lane topology: ${message}`); };
  for (const [lane, { job: jobId, packages }] of Object.entries(CI_LANE_TOPOLOGY)) {
    const job = workflow.jobs?.[jobId];
    if (!job) fail(`missing job ${jobId}`);
    if (!String(job.if).includes(`needs.changes.outputs.${lane} == 'true'`)) fail(`${jobId} lost planner condition ${lane}`);
    if (!packages) continue;
    if (job.env?.DKG_CI_COVERAGE !== '1') fail(`${jobId} must collect coverage`);
    if (!workflow.jobs['coverage-results']?.needs?.includes(jobId)) fail(`${jobId} is missing from coverage aggregation`);
    const steps = job.steps ?? [];
    const scripts = steps.map((step) => step.run ?? '').join('\n').replace(/\\\n\s*/g, ' ');
    const invoked = [...scripts.matchAll(/run-vitest-junit\.mjs\s+--lane\s+([a-z0-9-]+)/g)].map((match) => match[1]);
    if (scripts.includes('run-vitest-lanes.mjs')) {
      if (!scripts.includes(`run-vitest-lanes.mjs --job ${jobId} --concurrency `)) fail(`${jobId} delegates to the wrong package group`);
      if (Object.values(packages).some((count) => count !== 1)) fail(`${jobId} cannot delegate sharded packages`);
      invoked.push(...Object.keys(packages));
    }
    if (JSON.stringify(invoked.sort()) !== JSON.stringify(Object.keys(packages).sort())) fail(`${jobId} package invocations disagree with receipt expectations`);
    for (const [name, count] of Object.entries(packages)) {
      if (count === 1) continue;
      const matrix = job.strategy?.matrix;
      const rows = matrix?.include?.filter((row) => row.suite === name);
      const shards = rows ? rows.map((row) => row.shard) : matrix?.shard;
      if (JSON.stringify(shards) !== JSON.stringify(Array.from({ length: count }, (_, n) => n + 1))) fail(`${jobId}/${name} shard matrix must contain 1..${count}`);
      const labels = rows ? rows.map((row) => row.label) : [job.name];
      if (labels.some((label) => !label.includes(`/${count}]`))) fail(`${jobId}/${name} shard labels disagree`);
      if (name === 'publisher' && !scripts.includes(`--shard=${'${{ matrix.shard }}'}/${count}`)) fail(`${jobId} Vitest shard denominator disagrees`);
      if (name === 'agent' && !scripts.includes(`ci-shard-agent.mjs ${'${{ matrix.shard }}'} ${count}`)) fail(`${jobId} shard planner count disagrees`);
      if ((name === 'cli' || name === 'chain') && !scripts.includes(`plan-vitest-shard.mjs ${name} `)) fail(`${jobId}/${name} must use the canonical shard planner`);
    }
    if (jobId === 'tornado-core') {
      const coreRows = job.strategy?.matrix?.include?.filter((row) => row.suite === 'core');
      if (coreRows?.length !== 1 || coreRows[0].shard !== 0 || job.strategy.matrix.include.length !== packages.chain + 1) fail('tornado-core must run one unsharded core group plus the chain shards');
    }
  }
  const runners = Object.entries(workflow.jobs).filter(([, job]) => job.steps?.some((step) => /run-vitest-(?:junit|lanes)\.mjs/.test(step.run ?? ''))).map(([job]) => job).sort();
  if (JSON.stringify(runners) !== JSON.stringify(Object.keys(COVERAGE_JOBS).sort())) fail('workflow has an unregistered coverage runner');
}
