#!/usr/bin/env node
/**
 * Four real-Hardhat shards and six existing-unit-config shards, weighted from
 * reviewed JUnit timings. Unknown files retain a conservative 60s estimate.
 * Discovery uses Vitest itself and every eligible file is assigned once.
 *
 * node scripts/ci-shard-agent.mjs <shardId> 10 [--config]
 * --config prints the selected Vitest config without running discovery.
 */
import { AGENT_SHARD_COUNT, agentShardDescriptor, planAgentShards } from '../../../scripts/ci/plan-agent-shards.mjs';

const [shardText, countText, option, ...extra] = process.argv.slice(2);
const shard = Number(shardText);
try {
  if (String(shard) !== shardText || countText !== String(AGENT_SHARD_COUNT)
      || (option !== undefined && option !== '--config') || extra.length > 0) {
    throw new Error(`usage: ci-shard-agent.mjs <shardId> ${AGENT_SHARD_COUNT} [--config]`);
  }
  const descriptor = agentShardDescriptor(shard);
  if (option === '--config') {
    console.log(descriptor.config);
  } else {
    const plan = planAgentShards()[shard - 1];
    if (!plan.files.length) throw new Error(`Agent shard ${shard} is empty`);
    console.error(`agent-shard: ${shard}/${AGENT_SHARD_COUNT} ${plan.config}: ${plan.files.length} files, ${(plan.estimatedMs / 1000).toFixed(1)}s estimated, ${plan.unknownFiles.length} unmeasured`);
    for (const file of plan.files) console.log(file);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
