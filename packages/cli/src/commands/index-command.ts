import { Command } from 'commander';

import { toErrorMessage } from '@origintrail-official/dkg-core';

import { ApiClient } from '../api-client.js';

import { publishEntityBatches } from '../cli-helpers.js';
import type { ActionOpts } from '../cli-helpers.js';

export function registerIndexCommand(program: Command): void {
// ─── dkg index ──────────────────────────────────────────────────────

program
  .command('index [directory]')
  .description('Index a repository and stage or publish it as a named knowledge asset')
  .option('-p, --context-graph <id>', 'Target context graph', 'dev-coordination')
  .option('--shared-memory', 'Stage indexed quads as a named WM knowledge asset instead of publishing')
  .option('--workspace', 'Stage indexed quads as a named WM knowledge asset instead of publishing (legacy alias)')
  .option('--include-content', 'Index docs/content files in addition to source code')
  .option('--solidity-ast', 'Use Hardhat build-info ASTs for Solidity indexing (adds StateVariable/Event/Error/Modifier and a call-graph). Falls back to regex for packages without artifacts/build-info/.')
  .option('--dry-run', 'Print statistics without publishing')
  .option('--output <file>', 'Write quads to a JSON file instead of publishing')
  .action(async (directory: string | undefined, opts: ActionOpts) => {
    try {
      const { resolve } = await import('node:path');
      const repoRoot = resolve(directory ?? '.');
      const targetContextGraph = opts.contextGraph ?? 'dev-coordination';
      const useSharedMemory = opts.sharedMemory || opts.workspace;

      console.log(`Indexing ${repoRoot}...`);
      const { indexRepository } = await import('../indexer.js');
      const result = await indexRepository(repoRoot, {
        includeContent: Boolean(opts.includeContent),
        solidityAst: Boolean(opts.solidityAst),
        contextGraphId: targetContextGraph,
      });

      console.log(`\n  Packages:  ${result.packageCount}`);
      console.log(`  Modules:   ${result.moduleCount}`);
      console.log(`  Functions: ${result.functionCount}`);
      console.log(`  Classes:   ${result.classCount}`);
      console.log(`  Contracts: ${result.contractCount}`);
      console.log(`  Quads:     ${result.quads.length}`);

      if (opts.output) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(opts.output, JSON.stringify(result.quads, null, 2));
        console.log(`\nWritten to ${opts.output}`);
        return;
      }

      if (opts.dryRun) {
        console.log('\n  (dry run — not publishing)');
        return;
      }

      const client = await ApiClient.connect();
      const indexAssertionName = `index-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const verb = useSharedMemory ? 'Staging WM knowledge asset' : 'Writing KA draft';
      if (result.quads.length === 0) {
        console.log('\n\n  No quads to stage or publish.');
        return;
      }
      await client.createAssertion(targetContextGraph, indexAssertionName);
      const applyBatch = async (batch: typeof result.quads) => client.appendToAssertion(
        targetContextGraph,
        indexAssertionName,
        batch,
      );

      await publishEntityBatches(result.quads, applyBatch, (sent) => {
        process.stdout.write(`\r  ${verb}: ${sent}/${result.quads.length} quads`);
      }, {
        maxBatchBytes: 240 * 1024,
        estimateBatchBytes: (batch) => new TextEncoder().encode(JSON.stringify({ contextGraphId: targetContextGraph, quads: batch })).length,
        splitOversizedEntities: true,
      });

      if (useSharedMemory) {
        console.log(`\n\n  Staged ${result.quads.length} quads into WM knowledge asset "${indexAssertionName}" for context graph "${targetContextGraph}".`);
        console.log("  Next: finalize, share, and publish it through the knowledge-assets lifecycle API.");
      } else {
        process.stdout.write(`\n  Finalizing "${indexAssertionName}"...`);
        await client.finalizeAssertion(targetContextGraph, indexAssertionName);
        process.stdout.write(`\n  Sharing "${indexAssertionName}" to SWM...`);
        await client.knowledgeAssetShare(targetContextGraph, indexAssertionName);
        process.stdout.write(`\n  Publishing "${indexAssertionName}" to VM...`);
        const published = await client.publishFromFinalizedAssertion(targetContextGraph, indexAssertionName);
        console.log(`\n\n  Published ${result.quads.length} quads as knowledge asset "${indexAssertionName}" in context graph "${targetContextGraph}".`);
        console.log(`  Status: ${published.status}`);
        console.log(`  KA ID:  ${published.kaId}`);
        if (published.txHash) console.log(`  TX:     ${published.txHash}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
