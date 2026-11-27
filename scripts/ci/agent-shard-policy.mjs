import { readFileSync } from 'node:fs';

export const AGENT_SHARD_POLICY_FILE = new URL('./agent-shard-policy.json', import.meta.url);

export function loadAgentShardPolicy(file = AGENT_SHARD_POLICY_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.lanes) || raw.lanes.length !== 2) {
    throw new Error('Invalid agent shard policy: expected schema 1 with integration and unit lanes');
  }
  const inventories = new Set();
  const reports = new Set();
  const lanes = Object.freeze(raw.lanes.map((lane) => {
    if (!['integration', 'unit'].includes(lane.inventory) || inventories.has(lane.inventory)
        || typeof lane.config !== 'string' || !lane.config || !Array.isArray(lane.shards) || !lane.shards.length) {
      throw new Error('Invalid agent shard lane');
    }
    inventories.add(lane.inventory);
    const shards = Object.freeze(lane.shards.map(({ report, reservedOverheadMs }) => {
      if (typeof report !== 'string' || !/^[\w.-]+\.xml$/.test(report) || reports.has(report)
          || !Number.isFinite(reservedOverheadMs) || reservedOverheadMs < 0) {
        throw new Error('Invalid or duplicate agent shard report/overhead');
      }
      reports.add(report);
      return Object.freeze({ report, reservedOverheadMs });
    }));
    return Object.freeze({ config: lane.config, inventory: lane.inventory, shards });
  }));
  const descriptors = Object.freeze(lanes.flatMap((lane) => lane.shards.map((shard) => ({
    ...shard, config: lane.config, inventory: lane.inventory,
  }))).map((shard, index) => Object.freeze({ ...shard, index: index + 1 })));
  return Object.freeze({ lanes, descriptors });
}

export const AGENT_SHARD_POLICY = loadAgentShardPolicy();
