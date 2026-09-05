import { Command } from 'commander';

import { toErrorMessage } from '@origintrail-official/dkg-core';

import { ApiClient } from '../api-client.js';

import { formatQuadObject } from '../cli-helpers.js';
import type { ActionOpts } from '../cli-helpers.js';

export function registerAssertionCommand(program: Command): void {
// ─── dkg assertion ──────────────────────────────────────────────────

const assertionCmd = program
  .command('assertion')
  .description('Assertion document import and extraction status');

assertionCmd
  .command('import-file <name>')
  .description('Import a document into an assertion graph via multipart upload (PDF, Markdown, DOCX, etc.)')
  .requiredOption('-f, --file <path>', 'Path to the source document')
  .requiredOption('-c, --context-graph <id>', 'Target context graph')
  .option('--content-type <type>', 'Override detected upload content type')
  .option('--ontology-ref <uri>', 'Context graph _ontology URI for guided extraction')
  .option('--sub-graph-name <name>', 'Target registered sub-graph inside the context graph')
  .action(async (name: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.importAssertionFile(name, {
        filePath: opts.file,
        contextGraphId: opts.contextGraph,
        contentType: opts.contentType,
        ontologyRef: opts.ontologyRef,
        subGraphName: opts.subGraphName,
      });
      console.log('Assertion import complete:');
      console.log(`  Assertion URI:         ${result.assertionUri}`);
      console.log(`  File hash:             ${result.fileHash}`);
      if (result.detectedContentType) {
        console.log(`  Detected content type: ${result.detectedContentType}`);
      }
      if (result.extraction) {
        console.log(`  Extraction status:     ${result.extraction.status}`);
        if (result.extraction.pipelineUsed) {
          console.log(`  Pipeline:              ${result.extraction.pipelineUsed}`);
        }
        if (typeof result.extraction.tripleCount === 'number') {
          console.log(`  Triples:               ${result.extraction.tripleCount}`);
        }
        if (result.extraction.mdIntermediateHash) {
          console.log(`  Markdown hash:         ${result.extraction.mdIntermediateHash}`);
        }
        if (result.extraction.error) {
          console.log(`  Extraction error:      ${result.extraction.error}`);
        }
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

assertionCmd
  .command('extraction-status <name>')
  .description('Show the latest extraction status for an imported assertion document')
  .requiredOption('-c, --context-graph <id>', 'Target context graph')
  .option('--sub-graph-name <name>', 'Target registered sub-graph inside the context graph')
  .action(async (name: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.assertionExtractionStatus(name, opts.contextGraph, opts.subGraphName);
      console.log(`Extraction status for "${name}":`);
      if (result.assertionUri) {
        console.log(`  Assertion URI:  ${result.assertionUri}`);
      }
      if (result.fileHash) {
        console.log(`  File hash:      ${result.fileHash}`);
      }
      console.log(`  Status:         ${result.status ?? 'unknown'}`);
      if (result.pipelineUsed) {
        console.log(`  Pipeline:       ${result.pipelineUsed}`);
      }
      if (typeof result.tripleCount === 'number') {
        console.log(`  Triples:        ${result.tripleCount}`);
      }
      if (result.mdIntermediateHash) {
        console.log(`  Markdown hash:  ${result.mdIntermediateHash}`);
      }
      if (result.error) {
        console.log(`  Error:          ${result.error}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

assertionCmd
  .command('promote <name>')
  .description('Promote an assertion from local working memory into shared memory')
  .requiredOption('-c, --context-graph <id>', 'Target context graph')
  .option('--entity <uri...>', 'Promote only specific root entities (defaults to all)')
  .option('--sub-graph-name <name>', 'Source sub-graph inside the context graph')
  .action(async (name: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.promoteAssertion(name, {
        contextGraphId: opts.contextGraph,
        entities: opts.entity?.length ? opts.entity as string[] : 'all',
        subGraphName: opts.subGraphName,
      });
      const promotedCount = result.promotedCount ?? result.count ?? 0;
      if (promotedCount === 0) {
        console.error(`No quads were promoted for assertion "${name}".`);
        console.error('The assertion is empty, does not exist under that name, or only contains non-promotable bookkeeping quads.');
        console.error(`Inspect it with: dkg assertion query ${name} --context-graph ${opts.contextGraph}${opts.subGraphName ? ` --sub-graph-name ${opts.subGraphName}` : ''}`);
        process.exit(1);
      }
      console.log(`Assertion promoted to shared memory:`);
      console.log(`  Name:           ${name}`);
      console.log(`  Context graph:  ${result.contextGraphId ?? opts.contextGraph}`);
      console.log(`  Triples:        ${promotedCount}`);
      if (result.sharedMemoryGraph) {
        console.log(`  Shared graph:   ${result.sharedMemoryGraph}`);
      }
      if (Array.isArray(result.rootEntities) && result.rootEntities.length > 0) {
        console.log(`  Root entities:  ${result.rootEntities.join(', ')}`);
      }
      console.log(`  Next:           dkg ka publish-async ${name} --context-graph-id ${opts.contextGraph}${opts.subGraphName ? ` --sub-graph-name ${opts.subGraphName}` : ''}`);
      console.log(`  Alias:          dkg publisher publish-async ${opts.contextGraph} ${name}${opts.subGraphName ? ` --sub-graph ${opts.subGraphName}` : ''}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

assertionCmd
  .command('query <name>')
  .description('Inspect the quads currently stored in an assertion graph (local memory before promote)')
  .requiredOption('-c, --context-graph <id>', 'Target context graph')
  .option('--sub-graph-name <name>', 'Target registered sub-graph inside the context graph')
  .option('--json', 'Print JSON instead of N-Quads-like lines')
  .action(async (name: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.queryAssertion(name, {
        contextGraphId: opts.contextGraph,
        subGraphName: opts.subGraphName,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.count === 0) {
        console.log(`No quads found for assertion "${name}".`);
        return;
      }
      for (const quad of result.quads) {
        console.log(`<${quad.subject}> <${quad.predicate}> ${formatQuadObject(quad.object)} <${quad.graph}> .`);
      }
      console.log(`\n${result.count} quad(s)`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
