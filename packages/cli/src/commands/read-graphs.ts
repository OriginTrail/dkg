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

interface ScopeOptions {
  readonly contextGraph?: string;
  readonly layer?: string;
}

/**
 * `dkg store read-graphs status | check | rebuild | drop`: the read graphs a
 * running node keeps, the merged copies of a context graph's layers. Every
 * command takes `--context-graph` and `--layer` to narrow it, and needs the
 * node-admin token.
 */
export function registerReadGraphsCommand(program: Command): void {
  const store = program.commands.find((command) => command.name() === 'store')
    ?? program.command('store').description('The node\'s triple store');
  const readGraphs = store.command('read-graphs')
    .description('Read graphs: the merged copies of a context graph\'s layers that a node keeps (node-admin token)');
  const scoped = (command: Command) => command
    .option('--context-graph <id>', 'Only the read graphs of this context graph')
    .option('--layer <layer>', `Only the read graphs of this layer: ${READ_GRAPH_LAYER_LABELS.join(', ')}`);

  scoped(readGraphs.command('status'))
    .description('List the read graphs, their state and generation')
    .option('--json', 'Print the node\'s answer as JSON')
    .action((options: ScopeOptions & { json?: boolean }) => run('status', scopeOf(options), async (client, request) => {
      const answer = await client.readGraphs<ReadGraphsStatusAnswer>('status', request);
      if (options.json) return console.log(JSON.stringify(answer, null, 2));
      if (answer.readGraphs.length === 0) return console.log('No read graphs.');
      for (const graph of answer.readGraphs) {
        const scope = graph.subGraphName ? `${graph.contextGraphId} sub-graph ${graph.subGraphName}` : graph.contextGraphId;
        const agent = graph.agentAddress ? ` agent ${graph.agentAddress}` : '';
        console.log(`${graph.state.padEnd(10)} ${graph.layer.padEnd(3)} ${scope}${agent} (generation ${graph.generation})`);
      }
      const states = Object.entries(answer.states).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`);
      console.log(`${answer.readGraphs.length} read graph(s): ${states.join(', ')}.`);
    }));

  scoped(readGraphs.command('check'))
    .description('Check each ready read graph against its member graphs; a mismatch marks it dirty')
    .option('--sampled', 'Probe a sample of member graphs instead of every one')
    .action((options: ScopeOptions & { sampled?: boolean }) => run('check', { ...scopeOf(options), mode: options.sampled ? 'sampled' : 'full' },
      async (client, request) => {
        const answer = await client.readGraphs<ReadGraphsCheckAnswer>('check', request);
        if (answer.results.length === 0) return console.log('No read graphs to check.');
        for (const result of answer.results) {
          const detail = result.direction ? ` (${result.direction})` : result.error ? `: ${result.error}` : '';
          console.log(`${result.outcome}${detail} ${result.readGraph}`);
        }
        // A mismatch or a failure is a result a script should notice.
        if (answer.results.some((result) => result.outcome === 'mismatch' || result.outcome === 'error')) process.exitCode = 1;
      }));

  scoped(readGraphs.command('rebuild'))
    .description('Mark the read graphs dirty; the node\'s builder rebuilds them at its next pass')
    .action((options: ScopeOptions) => run('rebuild', scopeOf(options), async (client, request) => {
      const answer = await client.readGraphs<ReadGraphsRebuildAnswer>('rebuild', request);
      if (answer.marked.length === 0) return console.log('No read graphs to rebuild.');
      for (const marked of answer.marked) {
        console.log(marked.error ? `error: ${marked.error} ${marked.readGraph}` : `${marked.state ?? 'removed'} ${marked.readGraph}`);
      }
      if (answer.marked.some((marked) => marked.error)) process.exitCode = 1;
      else console.log('The node\'s builder rebuilds them at its next pass.');
    }));

  scoped(readGraphs.command('drop'))
    .description('Remove the read graphs, their contents and their state')
    .option('--yes', 'Drop them; without it, the command lists what it would drop')
    .action((options: ScopeOptions & { yes?: boolean }) => run('drop', scopeOf(options), async (client, request) => {
      if (!options.yes) {
        const answer = await client.readGraphs<ReadGraphsStatusAnswer>('status', request);
        if (answer.readGraphs.length === 0) return console.log('No read graphs to drop.');
        for (const graph of answer.readGraphs) console.log(`would drop ${graph.readGraph}`);
        console.log(`Run again with --yes to drop ${answer.readGraphs.length} read graph(s).`);
        process.exitCode = 1;
        return;
      }
      const answer = await client.readGraphs<ReadGraphsDropAnswer>('drop', request);
      if (answer.removed.length === 0) return console.log('No read graphs to drop.');
      for (const removed of answer.removed) {
        console.log(`${removed.outcome}${removed.error ? `: ${removed.error}` : ''} ${removed.readGraph}`);
      }
      if (answer.removed.some((removed) => removed.outcome !== 'done' && removed.outcome !== 'current')) process.exitCode = 1;
    }));
}

function scopeOf(options: ScopeOptions): Record<string, string> {
  return {
    ...(options.contextGraph === undefined ? {} : { contextGraphId: options.contextGraph }),
    ...(options.layer === undefined ? {} : { layer: options.layer }),
  };
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
