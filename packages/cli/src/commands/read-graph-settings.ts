// SPDX-License-Identifier: Apache-2.0
import type { Command } from 'commander';
import { isReadGraphEligibleContextGraphId, type GetView } from '@origintrail-official/dkg-core';
import type { ReadGraphMode, ReadGraphModeChange } from '@origintrail-official/dkg-storage';
import { ApiClient } from '../api-client.js';
import {
  parseReadGraphSettingsRequest,
  type ReadGraphSettingsAnswer,
  type ReadGraphSettingsRequest,
} from '../read-graph-settings-wire.js';
import {
  FEATURE_NAME,
  LAYER_OPTION_HELP,
  MEMORIES,
  MODE_OPTION_HELP,
  changeLine,
  changesToName,
  layerLine,
  memoryOf,
  modeWord,
  parseLayerOption,
  parseModeOption,
  parseSemanticsArgument,
  policyLine,
  readGraphsOf,
  semanticsLine,
  semanticsWords,
  stateWords,
} from '../read-graph-settings-words.js';

interface Options {
  readonly contextGraph?: string;
  readonly layer?: string;
  readonly mode?: string;
  readonly json?: boolean;
}

type Body = Omit<ReadGraphSettingsRequest, 'contextGraphId'>;

/**
 * `dkg store read-graphs enable | disable | settings | default-semantics`:
 * search across assets, per context graph and memory, switched on a running
 * node without a restart. Each needs the node-admin token. `--json` prints the
 * node's answer with the engine's values (off, build, serve, merged, per-asset).
 */
export function registerReadGraphSettingsCommands(readGraphs: Command): void {
  readGraphs.command('enable')
    .description(`${FEATURE_NAME}: switch a context graph's memory to preview or on`)
    .requiredOption('-c, --context-graph <id>', 'The context graph')
    .option('--layer <memory>', LAYER_OPTION_HELP)
    .option('--mode <mode>', MODE_OPTION_HELP)
    .option('--json', 'Print the node\'s answer as JSON')
    .action((options: Options) => change(options, () => {
      const layers = parseLayerOption(options.layer);
      if ('error' in layers) return layers;
      const mode = parseModeOption(options.mode);
      if ('error' in mode) return mode;
      return { layers: Object.fromEntries(layers.layers.map((layer) => [layer, mode.mode])) };
    }));

  readGraphs.command('disable')
    .description(`${FEATURE_NAME}: switch a context graph's memory off; its combined copy is removed in the background`)
    .requiredOption('-c, --context-graph <id>', 'The context graph')
    .option('--layer <memory>', LAYER_OPTION_HELP)
    .option('--json', 'Print the node\'s answer as JSON')
    .action((options: Options) => change(options, () => {
      const layers = parseLayerOption(options.layer);
      return 'error' in layers ? layers : { layers: Object.fromEntries(layers.layers.map((layer) => [layer, 'off'])) };
    }));

  readGraphs.command('default-semantics <semantics>')
    .description('What queries on a context graph get when they don\'t choose: merged searches across assets, '
      + 'per-asset searches each asset on its own, none follows the node\'s default')
    .requiredOption('-c, --context-graph <id>', 'The context graph')
    .option('--json', 'Print the node\'s answer as JSON')
    .action((semantics: string, options: Options) => change(options, () => {
      const parsed = parseSemanticsArgument(semantics);
      return 'error' in parsed ? parsed : { viewSemantics: parsed.viewSemantics };
    }));

  readGraphs.command('settings')
    .description(`${FEATURE_NAME}: what each context graph's memories are set to, and how far each one is`)
    .option('-c, --context-graph <id>', 'Only this context graph')
    .option('--json', 'Print the node\'s answer as JSON')
    .action((options: Options) => run(async () => {
      // The node's own check of the ID, before it is asked.
      if (options.contextGraph !== undefined && !isReadGraphEligibleContextGraphId(options.contextGraph)) {
        throw new Error('--context-graph must be the ID of a context graph that can search across assets.');
      }
      const answer = await (await ApiClient.connect()).readGraphSettings.get(options.contextGraph);
      if (options.json) return printJson(answer);
      console.log(policyLine(answer.policy));
      if (answer.refused) console.log(`This node can't switch it on: ${answer.refused.error}`);
      if (answer.contextGraphs.length === 0) return console.log('No context graph has settings or read graphs.');
      for (const settings of answer.contextGraphs) {
        console.log(settings.contextGraphId);
        for (const layer of MEMORIES) console.log(`  ${layerLine(settings, layer)}`);
        console.log(`  ${semanticsLine(settings)}`);
      }
    }));
}

/** Check the change as the node will, send it, and say what changed; a refusal is printed and exits 1. */
async function change(options: Options, build: () => Body | { readonly error: string }): Promise<void> {
  await run(async () => {
    const body = build();
    if ('error' in body) throw new Error(body.error);
    const parsed = parseReadGraphSettingsRequest({ contextGraphId: options.contextGraph, ...body });
    if ('error' in parsed) throw new Error(parsed.error);
    const client = await ApiClient.connect();
    let answer: ReadGraphSettingsAnswer;
    try {
      answer = await client.readGraphSettings.set(parsed.request);
    } catch (error) {
      // A refused apply puts the settings back, and its answer says what each layer did.
      const changes = (error as { responseBody?: { changes?: readonly ReadGraphModeChange[] } }).responseBody?.changes;
      if (!options.json) for (const refused of changesToName(changes ?? [], parsed.request)) console.log(changeLine(refused));
      throw error;
    }
    if (answer.changes?.some((applied) => typeof applied.outcome === 'object')) process.exitCode = 1;
    if (options.json) return printJson(answer);
    for (const line of changeLines(answer, parsed.request)) console.log(line);
  });
}

/** What a change did, from the node's answer for that context graph. */
function changeLines(answer: ReadGraphSettingsAnswer, change: ReadGraphSettingsRequest): string[] {
  const settingsOf = (contextGraphId: string) => answer.contextGraphs.find((candidate) => candidate.contextGraphId === contextGraphId);
  const settings = settingsOf(change.contextGraphId);
  // A memory's state comes from its own context graph's settings, which the answer holds only for the one changed.
  const state = (contextGraphId: string, layer: GetView, mode: ReadGraphMode) => {
    const of = settingsOf(contextGraphId);
    return of === undefined ? undefined : stateWords(mode, readGraphsOf(of, layer));
  };
  const lines = answer.changes !== undefined
    ? changesToName(answer.changes, change).map((applied) => changeLine(applied, state(applied.contextGraphId, applied.layer, applied.to)))
    // A node that does not list the changes still answers with the modes in force.
    : Object.entries(change.layers ?? {}).map(([layer, asked]) => {
      const memory = layer as GetView;
      const mode = settings?.effective?.layers[memory] ?? asked;
      return `${memoryOf(memory, change.contextGraphId)}: ${modeWord(mode)}.${mode === 'off' ? '' : ` ${state(change.contextGraphId, memory, mode) ?? 'Getting ready'}.`}`;
    });
  if (change.viewSemantics !== undefined) {
    const inForce = settings?.effective?.viewSemantics ?? change.viewSemantics ?? 'per-asset';
    lines.push(change.viewSemantics === null
      ? `Queries on ${change.contextGraphId} that don't choose follow the node's default: ${semanticsWords(inForce)}.`
      : `Queries on ${change.contextGraphId} that don't choose now ${semanticsWords(change.viewSemantics)}.`);
  }
  return lines;
}

function printJson(answer: unknown): void {
  console.log(JSON.stringify(answer, null, 2));
}

/** Run a command; a failure is printed and exits 1. */
async function run(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    // An older node has no settings route.
    const status = (error as { httpStatus?: number }).httpStatus;
    console.error(status === 404
      ? 'This node cannot change search across assets yet: update it to a release with the read-graph settings.'
      : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
