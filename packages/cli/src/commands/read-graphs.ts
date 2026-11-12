import { Option, type Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { registerReadGraphSettingsCommands } from './read-graph-settings.js';
import {
  READ_GRAPH_LAYER_LABELS,
  parseReadGraphsRequest,
  type ReadGraphsAction,
  type ReadGraphsCheckAnswer,
  type ReadGraphsDropAnswer,
  type ReadGraphsRebuildAnswer,
  type ReadGraphsRequest,
  type ReadGraphsStatusAnswer,
} from '../read-graphs-wire.js';

interface CommandOptions {
  readonly contextGraph?: string;
  readonly layer?: string;
  readonly json?: boolean;
}

/**
 * `dkg store read-graphs status | check | rebuild | drop`: the read graphs a
 * running node keeps, the merged copies of a context graph's layers that let
 * queries search across assets; `enable`, `disable`, `settings` and
 * `default-semantics` switch them (./read-graph-settings.ts). `status`,
 * `rebuild` and `drop` take `--context-graph` and `--layer` to narrow them;
 * `check` checks every ready read graph. Every command takes `--json` to print
 * the node's answer, with the same exit code, and needs the node-admin token.
 */
export function registerReadGraphsCommand(program: Command): void {
  const store = program.commands.find((command) => command.name() === 'store')
    ?? program.command('store').description('The node\'s triple store');
  const readGraphs = store.command('read-graphs')
    .description('Search across assets: the combined copies (read graphs) of a context graph\'s memories that a node keeps (node-admin token)');
  const command = (name: string) => readGraphs.command(name).option('--json', 'Print the node\'s answer as JSON');
  const scoped = (name: string) => command(name)
    .option('-c, --context-graph <id>', 'Only the read graphs of this context graph')
    .option('--layer <layer>', `Only the read graphs of this layer: ${READ_GRAPH_LAYER_LABELS.join(', ')}`);

  scoped('status')
    .description('List the read graphs with their state and generation, what the builder does, and the last check')
    .action((options: CommandOptions) => run('status', scopeOf(options), async (client, request) => {
      const answer = await client.readGraphs<ReadGraphsStatusAnswer>('status', request);
      if (options.json) return printJson(answer);
      for (const graph of answer.readGraphs) {
        const scope = graph.subGraphName ? `${graph.contextGraphId} sub-graph ${graph.subGraphName}` : graph.contextGraphId;
        const agent = graph.agentAddress ? ` agent ${graph.agentAddress}` : '';
        console.log(`${graph.state.padEnd(10)} ${graph.layer.padEnd(3)} ${scope}${agent} (generation ${graph.generation})`);
      }
      const states = Object.entries(answer.states).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
      console.log(answer.readGraphs.length === 0 ? 'No read graphs.' : `${answer.readGraphs.length} read graph(s): ${states.join(', ')}.`);
      const builder = answer.builder;
      console.log(!builder?.running ? 'Builder: not running.' : `Builder: running, ${builder.building ? `building ${builder.building}, ` : ''}`
        + `${builder.pending} to build, ${builder.retrying.length} waiting to retry.`);
      console.log(`Background checks: ${answer.checking ? 'running' : 'not running'}.`);
      if (answer.lastCheck) console.log(`Last check on request: ${describeCheck(answer.lastCheck)}`);
    }));

  command('check')
    .description('Check every ready read graph against its member graphs now; a mismatch marks it dirty. Exits 1 on a mismatch')
    .addOption(new Option('--full', 'Compare every triple (the default)').conflicts('sampled'))
    .option('--sampled', 'Probe a sample of member graphs instead')
    .action((options: CommandOptions & { full?: boolean; sampled?: boolean }) => run('check', { mode: options.sampled ? 'sampled' : 'full' },
      async (client, request) => {
        const answer = await client.readGraphs<ReadGraphsCheckAnswer>('check', request);
        // A mismatch is a result a script should notice.
        if (answer.results.some((result) => result.outcome === 'mismatch')) process.exitCode = 1;
        if (options.json) return printJson(answer);
        for (const result of answer.results) {
          console.log(`${result.outcome}${result.direction ? ` (${result.direction})` : ''} ${result.readGraph}`);
        }
        console.log(answer.results.length === 0 ? 'No ready read graphs to check.' : describeCheck(answer));
      }));

  scoped('rebuild')
    .description('Mark the read graphs dirty; the node\'s builder rebuilds them at its next pass. Refused while the builder does not run. Exits 1 if one could not be marked')
    .action((options: CommandOptions) => run('rebuild', scopeOf(options), async (client, request) => {
      const answer = await client.readGraphs<ReadGraphsRebuildAnswer>('rebuild', request);
      const failed = answer.marked.some((marked) => marked.error);
      if (failed) process.exitCode = 1;
      if (options.json) return printJson(answer);
      if (answer.marked.length === 0) return console.log('No read graphs to rebuild.');
      for (const marked of answer.marked) {
        console.log(marked.error ? `error: ${marked.error} ${marked.readGraph}` : `${marked.state ?? 'removed'} ${marked.readGraph}`);
      }
      if (!failed) console.log('The node\'s builder rebuilds them at its next pass.');
    }));

  scoped('drop')
    .description('Remove the read graphs, their contents and their state. Exits 1 unless each one is gone')
    .option('--yes', 'Drop them; without it, the command lists what it would drop and exits 1')
    .action((options: CommandOptions & { yes?: boolean }) => run('drop', scopeOf(options), async (client, request) => {
      if (!options.yes) {
        const answer = await client.readGraphs<ReadGraphsStatusAnswer>('status', request);
        if (answer.readGraphs.length > 0) process.exitCode = 1;
        if (options.json) return printJson(answer);
        if (answer.readGraphs.length === 0) return console.log('No read graphs to drop.');
        for (const graph of answer.readGraphs) console.log(`would drop ${graph.readGraph}`);
        console.log(`Run again with --yes to drop ${answer.readGraphs.length} read graph(s).`);
        return;
      }
      const answer = await client.readGraphs<ReadGraphsDropAnswer>('drop', request);
      if (answer.removed.some((removed) => removed.outcome !== 'done' && removed.outcome !== 'current')) process.exitCode = 1;
      if (options.json) return printJson(answer);
      if (answer.removed.length === 0) return console.log('No read graphs to drop.');
      for (const removed of answer.removed) {
        console.log(`${removed.outcome}${removed.error ? `: ${removed.error}` : ''} ${removed.readGraph}`);
      }
    }));

  registerReadGraphSettingsCommands(readGraphs);
}

function scopeOf(options: CommandOptions): Record<string, string> {
  return {
    ...(options.contextGraph === undefined ? {} : { contextGraphId: options.contextGraph }),
    ...(options.layer === undefined ? {} : { layer: options.layer }),
  };
}

/** For example `2026-11-11T08:00:00.000Z, full: 3 consistent, 1 mismatch.` */
function describeCheck(check: ReadGraphsCheckAnswer): string {
  const counts = new Map<string, number>();
  for (const result of check.results) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  const outcomes = [...counts].map(([outcome, count]) => `${count} ${outcome}`);
  return `${new Date(check.at).toISOString()}, ${check.mode}: ${outcomes.length === 0 ? 'no ready read graphs' : outcomes.join(', ')}.`;
}

function printJson(answer: unknown): void {
  console.log(JSON.stringify(answer, null, 2));
}

/** Check the options as the node will, connect, and run; a failure is printed and exits 1. */
async function run(
  action: ReadGraphsAction,
  raw: Record<string, string>,
  work: (client: ApiClient, request: ReadGraphsRequest) => Promise<void>,
): Promise<void> {
  try {
    const parsed = parseReadGraphsRequest(action, raw);
    if ('error' in parsed) throw new Error(parsed.error);
    await work(await ApiClient.connect(), parsed.request);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
