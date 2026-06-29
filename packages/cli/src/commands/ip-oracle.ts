import { Command } from 'commander';
import { toErrorMessage } from '@origintrail-official/dkg-core';
import {
  writePatentBundle,
  ingestPatentExport,
  type PatentGenOptions,
} from '@origintrail-official/dkg-ip-oracle';

/**
 * `dkg ip-oracle` — engineering harness for the IP / Patent Context Oracle.
 *
 * `generate` emits a deterministic, **synthetic** Google-Patents-shaped OKF
 * bundle to disk (no BigQuery / GCP dependency), which is then ingested into a
 * PRIVATE Context Graph via `dkg okf import --private`. The data is SIMULATED —
 * every concept stamps `source: … [SIMULATED]` and a CC BY 4.0 licence so the
 * downstream redaction guard and the public article stay honest about what is
 * real vs. generated.
 *
 * This command writes files only; it never touches the node and spends nothing.
 */
export function registerIpOracleCommand(program: Command): void {
  const cmd = program
    .command('ip-oracle')
    .description('IP / Patent Context Oracle tooling (synthetic OKF patent corpora)');

  cmd
    .command('generate <outDir>')
    .description('Generate a deterministic synthetic patent OKF bundle (no BigQuery needed)')
    .requiredOption('--count <n>', 'Number of patent concepts to emit', (v: string) => parseInt(v, 10))
    .option('--cpc-class <class>', 'CPC subclass tag, e.g. H04L', 'H04L')
    .option('--seed <n>', 'PRNG seed (same seed ⇒ identical corpus)', (v: string) => parseInt(v, 10), 42)
    .option('--citations-per-patent <n>', 'Max backward citations per patent', (v: string) => parseInt(v, 10))
    .option('--family-size <n>', 'Patents per simulated family', (v: string) => parseInt(v, 10))
    .option('--retrieval-date <iso>', 'Stamped retrieval / modified date (YYYY-MM-DD)')
    .action((outDir: string, opts: Record<string, unknown>) => {
      try {
        const count = Number(opts.count);
        if (!Number.isInteger(count) || count <= 0) {
          console.error('--count must be a positive integer.');
          process.exit(2);
        }
        const genOpts: PatentGenOptions = {
          cpcClass: String(opts.cpcClass ?? 'H04L'),
          count,
          seed: Number(opts.seed ?? 42),
          ...(opts.citationsPerPatent != null
            ? { citationsPerPatent: Number(opts.citationsPerPatent) }
            : {}),
          ...(opts.familySize != null ? { familySize: Number(opts.familySize) } : {}),
          ...(opts.retrievalDate ? { retrievalDate: String(opts.retrievalDate) } : {}),
        };
        const summary = writePatentBundle(genOpts, outDir);
        console.log(
          JSON.stringify(
            {
              mode: 'generate',
              ...summary,
              files: summary.conceptCount + 3, // patents + patents/index + index + log
              synthetic: true,
              note:
                'Synthetic SIMULATED corpus. Next: dkg okf import <outDir> ' +
                '--context-graph-id <cg> --private --create-context-graph',
            },
            null,
            2,
          ),
        );
      } catch (err) {
        console.error(toErrorMessage(err));
        process.exit(1);
      }
    });

  cmd
    .command('ingest <exportFile> <outDir>')
    .description(
      'Map a Google Patents Public Data NDJSON export (real data, run the BigQuery ' +
        'query yourself) into OKF bundle(s). Offline, deterministic, no GCP SDK.',
    )
    .option('--shard-by-cpc', 'Write one self-contained OKF bundle per CPC subclass (recommended at scale)')
    .option('--retrieval-date <iso>', 'Stamped retrieval / modified date (YYYY-MM-DD)')
    .action(async (exportFile: string, outDir: string, opts: Record<string, unknown>) => {
      try {
        const summary = await ingestPatentExport(exportFile, outDir, {
          shardByCpc: Boolean(opts.shardByCpc),
          ...(opts.retrievalDate ? { retrievalDate: String(opts.retrievalDate) } : {}),
        });
        console.log(
          JSON.stringify(
            {
              mode: 'ingest',
              ...summary,
              synthetic: false,
              note:
                'Real Google Patents Public Data (CC BY 4.0). Next, per shard: dkg okf ' +
                'import <shardDir> --context-graph-id <cg> --private --create-context-graph',
            },
            null,
            2,
          ),
        );
      } catch (err) {
        console.error(toErrorMessage(err));
        process.exit(1);
      }
    });
}
