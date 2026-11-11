import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
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
 * running node keeps, the merged copies of a context graph's layers. Every
 * command takes `--context-graph` and `--layer` to narrow it and `--json` to
 * print the node's answer, and needs the node-admin token. The exit code is
 * the same with `--json`.
 */
export function registerReadGraphsCommand(program: Command): void {
  const store = program.commands.find((command) => command.name() === 'store')
    ?? program.command('store').description('The node\'s triple store');
  const readGraphs = store.command('read-graphs')
    .description('Read graphs: the merged copies of a context graph\'s layers that a node keeps (node-admin token)');
  const command = (name: string) => readGraphs.command(name)
    .option('-c, --context-graph <id>', 'Only the read graphs of this context graph')
    .option('--layer <layer>', `Only the read graphs of this layer: ${READ_GRAPH_LAYER_LABELS.join(', ')}`)
    .option('--json', 'Print the node\'s answer as JSON');

  command('status')
    .description('List the read graphs, their state and generation')
    .action((options: CommandOptions) => run('status', scopeOf(options), async (client, request) => {
      const answer = await client.readGraphs<ReadGraphsStatusAnswer>('status', request);
      if (options.json) return printJson(answer);
      if (answer.readGraphs.length === 0) return console.log('No read graphs.');
      for (const graph of answer.readGraphs) {
        const scope = graph.subGraphName ? `${graph.contextGraphId} sub-graph ${graph.subGraphName}` : graph.contextGraphId;
        const agent = graph.agentAddress ? ` agent ${graph.agentAddress}` : '';
        console.log(`${graph.state.padEnd(10)} ${graph.layer.padEnd(3)} ${scope}${agent} (generation ${graph.generation})`);
      }
      const states = Object.entries(answer.states).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
      console.log(`${answer.readGraphs.length} read graph(s): ${states.join(', ')}.`);
    }));

  command('check')
    .description('Check each ready read graph against its member graphs; a mismatch marks it dirty. Exits 1 on a mismatch or a failed check')
    .option('--sampled', 'Probe a sample of member graphs instead of every one')
    .action((options: CommandOptions & { sampled?: boolean }) => run('check', { ...scopeOf(options), mode: options.sampled ? 'sampled' : 'full' },
      async (client, request) => {
        const answer = await client.readGraphs<ReadGraphsCheckAnswer>('check', request);
        // A mismatch or a failure is a result a script should notice.
        if (answer.results.some((result) => result.outcome === 'mismatch' || result.outcome === 'error')) process.exitCode = 1;
        if (options.json) return printJson(answer);
        if (answer.results.length === 0) return console.log('No read graphs to check.');
        for (const result of answer.results) {
          const detail = result.direction ? ` (${result.direction})` : result.error ? `: ${result.error}` : '';
          console.log(`${result.outcome}${detail} ${result.readGraph}`);
        }
      }));

  command('rebuild')
    .description('Mark the read graphs dirty; the node\'s builder rebuilds them at its next pass. Exits 1 if one could not be marked')
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

  command('drop')
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
}

function scopeOf(options: CommandOptions): Record<string, string> {
  return {
    ...(options.contextGraph === undefined ? {} : { contextGraphId: options.contextGraph }),
    ...(options.layer === undefined ? {} : { layer: options.layer }),
  };
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
