import { describe, it, expect } from 'vitest';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const DEVNET_DIR = join(REPO_ROOT, '.devnet');

const OBSERVATION_MS = Number(process.env.RPC_QUIET_WINDOW_MS ?? 185_000);
const MIN_EVALUATED_WINDOWS = Number(process.env.RPC_QUIET_MIN_WINDOWS ?? 1);
const MAX_ETH_GETLOGS = Number(process.env.RPC_QUIET_MAX_ETH_GETLOGS ?? 20);
const MAX_ETH_CHAINID = Number(process.env.RPC_QUIET_MAX_ETH_CHAINID ?? 5);
const MAX_TOTAL = Number(process.env.RPC_QUIET_MAX_TOTAL ?? 120);
const EXPECTED_DEVNET_NODES = Number(process.env.RPC_QUIET_EXPECTED_NODES ?? 6);
const EXPECTED_RPC_USAGE_WINDOW_SECONDS = Number(process.env.RPC_QUIET_EXPECTED_WINDOW_SECONDS ?? 60);

type UsageWindow = {
  node: string;
  timestamp: string;
  windowSeconds: number;
  mixedWindowSeconds?: boolean;
  byMethod: Record<string, number>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function discoverDaemonLogs(): Array<{ node: string; path: string }> {
  if (!existsSync(DEVNET_DIR)) {
    throw new Error('No .devnet directory found. Start a publisher-enabled devnet before running this suite.');
  }

  return readdirSync(DEVNET_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^node\d+$/.test(entry.name))
    .map((entry) => ({ node: entry.name, path: join(DEVNET_DIR, entry.name, 'daemon.log') }))
    .filter((entry) => existsSync(entry.path))
    .sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }));
}

function expectedDevnetNodes(count = EXPECTED_DEVNET_NODES): string[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`RPC_QUIET_EXPECTED_NODES must be a positive integer (got ${count})`);
  }
  return Array.from({ length: count }, (_, index) => `node${index + 1}`);
}

function missingExpectedDaemonLogs(
  logs: Array<{ node: string }>,
  expectedNodes = expectedDevnetNodes(),
): string[] {
  const observed = new Set(logs.map((log) => log.node));
  return expectedNodes
    .filter((node) => !observed.has(node))
    .map((node) => `${node}/daemon.log`);
}

function nodesWithoutPostWarmupWindows(
  windowsByNode: Map<string, UsageWindow[]>,
  expectedNodes = expectedDevnetNodes(),
  minWindows = MIN_EVALUATED_WINDOWS,
): string[] {
  return expectedNodes.filter((node) => {
    const windows = windowsByNode.get(node) ?? [];
    return windows.slice(1).length < minWindows;
  });
}

function invalidRpcUsageWindowDurations(
  windowsByNode: Map<string, UsageWindow[]>,
  expectedSeconds = EXPECTED_RPC_USAGE_WINDOW_SECONDS,
): string[] {
  if (!Number.isInteger(expectedSeconds) || expectedSeconds <= 0) {
    throw new Error(`RPC_QUIET_EXPECTED_WINDOW_SECONDS must be a positive integer (got ${expectedSeconds})`);
  }

  const invalid: string[] = [];
  for (const [node, windows] of windowsByNode) {
    for (const window of windows) {
      if (window.mixedWindowSeconds) {
        invalid.push(`${node} ${window.timestamp}: mixed window_s values`);
      } else if (window.windowSeconds !== expectedSeconds) {
        invalid.push(`${node} ${window.timestamp}: window_s=${window.windowSeconds}`);
      }
    }
  }
  return invalid;
}

function readNewText(path: string, startOffset: number): string {
  const endOffset = statSync(path).size;
  if (endOffset <= startOffset) return '';

  const length = endOffset - startOffset;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, startOffset);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

function parseRpcUsageWindows(node: string, text: string): UsageWindow[] {
  const windows = new Map<string, UsageWindow>();
  const lineRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*\brpc_usage method=([A-Za-z0-9_.:-]+) count=(\d+) window_s=(\d+)(?: chain=([A-Za-z0-9_.:-]+))?/gm;

  for (const match of text.matchAll(lineRe)) {
    const [, timestamp, method, countRaw, windowSecondsRaw] = match;
    const windowSeconds = Number(windowSecondsRaw);
    const key = `${node}:${timestamp}`;
    let window = windows.get(key);
    if (!window) {
      window = { node, timestamp, windowSeconds, byMethod: {} };
      windows.set(key, window);
    } else if (window.windowSeconds !== windowSeconds) {
      window.mixedWindowSeconds = true;
    }
    window.byMethod[method] = (window.byMethod[method] ?? 0) + Number(countRaw);
  }

  return [...windows.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function windowTotal(window: UsageWindow): number {
  return Object.values(window.byMethod).reduce((sum, count) => sum + count, 0);
}

describe('devnet RPC quiet-window budget', () => {
  it('keeps idle daemon rpc_usage under the lane-aware poller budget', async () => {
    const logs = discoverDaemonLogs();
    const missingLogs = missingExpectedDaemonLogs(logs);
    expect(missingLogs, `missing expected devnet daemon logs: ${missingLogs.join(', ')}`).toEqual([]);

    const offsets = new Map(logs.map((log) => [log.path, statSync(log.path).size]));
    await sleep(OBSERVATION_MS);

    const evaluated: UsageWindow[] = [];
    const missingTelemetry: string[] = [];
    const activityHints: string[] = [];
    const windowsByNode = new Map<string, UsageWindow[]>();

    for (const log of logs) {
      const chunk = readNewText(log.path, offsets.get(log.path) ?? 0);
      if (/\bChain event: (KCCreated|KnowledgeAssetCreated|ContextGraphCreated|KnowledgeAssetRegisteredToContextGraph)\b/.test(chunk)) {
        activityHints.push(log.node);
      }

      const windows = parseRpcUsageWindows(log.node, chunk);
      windowsByNode.set(log.node, windows);
      if (windows.length === 0) {
        missingTelemetry.push(log.node);
        continue;
      }

      evaluated.push(...windows.slice(1));
    }

    expect(
      activityHints,
      `quiet-window suite saw chain events in daemon logs: ${activityHints.join(', ')}; rerun without concurrent publishes or graph registrations`,
    ).toEqual([]);
    expect(missingTelemetry, `nodes without rpc_usage lines during observation: ${missingTelemetry.join(', ')}`).toEqual([]);
    const unevaluatedNodes = nodesWithoutPostWarmupWindows(windowsByNode);
    expect(
      unevaluatedNodes,
      `nodes without enough post-warmup rpc_usage windows: ${unevaluatedNodes.join(', ')}; increase RPC_QUIET_WINDOW_MS`,
    ).toEqual([]);
    const invalidWindowDurations = invalidRpcUsageWindowDurations(windowsByNode);
    expect(
      invalidWindowDurations,
      `rpc_usage window_s mismatch: ${invalidWindowDurations.join(', ')}`,
    ).toEqual([]);
    expect(evaluated.length, 'not enough post-warmup rpc_usage windows; increase RPC_QUIET_WINDOW_MS').toBeGreaterThanOrEqual(
      MIN_EVALUATED_WINDOWS * EXPECTED_DEVNET_NODES,
    );

    for (const window of evaluated) {
      const getLogs = window.byMethod.eth_getLogs ?? 0;
      const chainId = window.byMethod.eth_chainId ?? 0;
      const total = windowTotal(window);
      const label = `${window.node} ${window.timestamp} ${JSON.stringify(window.byMethod)}`;

      expect(getLogs, `${label}: eth_getLogs should be idle except slow context discovery`).toBeLessThanOrEqual(MAX_ETH_GETLOGS);
      expect(chainId, `${label}: static-network providers should suppress steady eth_chainId`).toBeLessThanOrEqual(MAX_ETH_CHAINID);
      expect(total, `${label}: total quiet-window RPC volume`).toBeLessThanOrEqual(MAX_TOTAL);
    }
  });

  it('parses the committed rpc_usage contract shape used by daemon logs', () => {
    const sample = readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8');
    expect(sample).toContain('dkg-devnet-rpc-quiet-window');

    const windows = parseRpcUsageWindows(
      'node1',
      '2026-07-04 10:00:00 system abc [chain-rpc] rpc_usage method=eth_getLogs count=2 window_s=60 chain=hardhat:31337\n' +
      '2026-07-04 10:00:00 system def [chain-rpc] rpc_usage method=eth_chainId count=0 window_s=60 chain=hardhat:31337\n',
    );

    expect(windows).toEqual([
      {
        node: 'node1',
        timestamp: '2026-07-04 10:00:00',
        windowSeconds: 60,
        byMethod: { eth_getLogs: 2, eth_chainId: 0 },
      },
    ]);
  });

  it('reports rpc_usage windows with unexpected durations', () => {
    const windows = parseRpcUsageWindows(
      'node1',
      '2026-07-04 10:00:00 system abc [chain-rpc] rpc_usage method=eth_getLogs count=2 window_s=10 chain=hardhat:31337\n',
    );

    expect(invalidRpcUsageWindowDurations(
      new Map([['node1', windows]]),
      60,
    )).toEqual(['node1 2026-07-04 10:00:00: window_s=10']);
  });

  it('reports mixed rpc_usage durations in the same timestamp bucket', () => {
    const windows = parseRpcUsageWindows(
      'node1',
      '2026-07-04 10:00:00 system abc [chain-rpc] rpc_usage method=eth_getLogs count=2 window_s=60 chain=hardhat:31337\n' +
      '2026-07-04 10:00:00 system def [chain-rpc] rpc_usage method=eth_chainId count=0 window_s=10 chain=hardhat:31337\n',
    );

    expect(windows).toHaveLength(1);
    expect(invalidRpcUsageWindowDurations(
      new Map([['node1', windows]]),
      60,
    )).toEqual(['node1 2026-07-04 10:00:00: mixed window_s values']);
  });

  it('fails preflight when expected devnet daemon logs are missing', () => {
    expect(missingExpectedDaemonLogs(
      [{ node: 'node1' }, { node: 'node3' }],
      ['node1', 'node2', 'node3'],
    )).toEqual(['node2/daemon.log']);
  });

  it('reports nodes that lack post-warmup rpc_usage windows', () => {
    const node1 = parseRpcUsageWindows(
      'node1',
      '2026-07-04 10:00:00 system abc [chain-rpc] rpc_usage method=eth_getLogs count=2 window_s=60 chain=hardhat:31337\n' +
      '2026-07-04 10:01:00 system abc [chain-rpc] rpc_usage method=eth_getLogs count=1 window_s=60 chain=hardhat:31337\n',
    );
    const node2 = parseRpcUsageWindows(
      'node2',
      '2026-07-04 10:00:00 system abc [chain-rpc] rpc_usage method=eth_getLogs count=50 window_s=60 chain=hardhat:31337\n',
    );

    expect(nodesWithoutPostWarmupWindows(
      new Map([
        ['node1', node1],
        ['node2', node2],
      ]),
      ['node1', 'node2'],
      1,
    )).toEqual(['node2']);
  });
});
