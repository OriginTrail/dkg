import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { ApiClient } from '../api-client.js';
import { parseSpec } from '../entity-search/documents.js';

export function registerEntitiesCommand(program: Command): void {
  const group = program.command('entities').description('Discover graph entities semantically, then query their RDF identities');
  group.command('index <spec-file>').option('--restart', 'Rescan current graph content and prune removed documents')
    .description('Build or resume an operator-managed local index; never starts network synchronization')
    .action(async (file: string, options: { restart?: boolean }) => {
      const spec = parseSpec(JSON.parse(await readFile(file, 'utf8')));
      const client = await ApiClient.connect();
      for (let page = 0; page < 12_501; page++) {
        const state = await client.entities.index({ ...spec, restart: page === 0 && options.restart === true });
        console.log(JSON.stringify(state));
        if (state.scanComplete) return;
      }
      throw new Error('Index page bound exceeded; narrow the entity selector');
    });
  group.command('search <context-graph> <index-id> <text>').option('--limit <n>', 'Maximum returned entities', '5')
    .action(async (contextGraphId: string, indexId: string, query: string, options: { limit: string }) => {
      const client = await ApiClient.connect();
      console.log(JSON.stringify(await client.entities.search({ contextGraphId, indexId, query, limit: Number(options.limit) }), null, 2));
    });
}
