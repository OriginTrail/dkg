// SPDX-License-Identifier: Apache-2.0
import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { formatViewSemanticsDeltaReport } from '../view-semantics-report.js';

export function registerViewSemanticsCommand(program: Command): void {
  const viewSemantics = program.command('view-semantics')
    .description('How view queries would answer with semantics "merged" instead of "per-asset"');
  viewSemantics.command('report')
    .description('Print the report of sampled view queries, per context graph (node-admin token)')
    .option('-c, --context-graph <id>', 'Report one context graph')
    .option('--json', 'Print the report as JSON')
    .action(async (options: { contextGraph?: string; json?: boolean }) => {
      try {
        const client = await ApiClient.connect();
        const report = await client.viewSemantics.deltaReport(options.contextGraph);
        console.log(options.json ? JSON.stringify(report, null, 2) : formatViewSemanticsDeltaReport(report));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
