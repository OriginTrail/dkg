#!/usr/bin/env node

import {
  auditTestnetHealthFiles,
  createDevnetHealthAudit,
  createIntegrityDataQuery,
  createIntegrityHeadQuery,
  createIntegrityReportRow,
  createSeedManifestRow,
  createSeedSummary,
  createWorkloadPlan,
  publicQuadsDigestFromPayload,
  validateIntegrityDataResponse,
  validateIntegrityHeadResponse,
  workloadPlanRowsTsv,
  workloadPlanSummaryTsv,
} from './private-cg-recovery.mjs';

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function readStdinJson() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return parseJson(input, 'stdin');
}

function writeJson(value, pretty = false) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'workload-plan':
      writeJson(createWorkloadPlan({
        profile: args[0],
        rootTriples: args[1],
        subgraphTriples: args[2],
        loadKaCount: args[3],
        loadTriplesPerKa: args[4],
      }));
      return;
    case 'workload-summary-tsv':
      process.stdout.write(workloadPlanSummaryTsv(parseJson(args[0], 'workload plan')));
      return;
    case 'workload-rows-tsv':
      process.stdout.write(`${workloadPlanRowsTsv(parseJson(args[0], 'workload plan'))}\n`);
      return;
    case 'payload-public-digest':
      process.stdout.write(publicQuadsDigestFromPayload(await readStdinJson()));
      return;
    case 'integrity-head-query':
      writeJson(createIntegrityHeadQuery({
        contextGraphId: args[0],
        subGraphName: args[1],
        manifest: parseJson(args[2], 'manifest row'),
      }));
      return;
    case 'validate-integrity-head':
      writeJson(validateIntegrityHeadResponse(parseJson(args[0], 'manifest row'), await readStdinJson()));
      return;
    case 'integrity-data-query':
      writeJson(createIntegrityDataQuery({
        contextGraphId: args[0],
        subGraphName: args[1],
        manifest: parseJson(args[2], 'manifest row'),
      }));
      return;
    case 'validate-integrity-data':
      writeJson(validateIntegrityDataResponse(parseJson(args[0], 'manifest row'), await readStdinJson()));
      return;
    case 'seed-manifest-row': {
      const writeResponse = await readStdinJson();
      writeJson(createSeedManifestRow({
        ordinal: args[0],
        lane: args[1],
        label: args[2],
        triples: args[3],
        payloadBytes: args[4],
        durationMs: args[5],
        expectedDigest: args[6],
        descriptor: parseJson(args[7], 'knowledge asset descriptor'),
        writeResponse,
      }));
      return;
    }
    case 'seed-summary':
      writeJson(createSeedSummary(parseJson(args[0], 'workload plan'), {
        kaCount: args[1],
        rootKaCount: args[2],
        subgraphKaCount: args[3],
        totalTriples: args[4],
        totalPayloadBytes: args[5],
        maxKaPayloadBytes: args[6],
        durationMs: args[7],
      }), true);
      return;
    case 'integrity-report-row':
      writeJson(createIntegrityReportRow({
        phase: args[0],
        node: args[1],
        expected: parseJson(args[2], 'manifest row'),
        swmHead: parseJson(args[3], 'SWM head result'),
        assertionGraph: parseJson(args[4], 'assertion graph result'),
      }));
      return;
    case 'audit-testnet-health': {
      const report = auditTestnetHealthFiles({
        baselineFile: args[0],
        samplesFile: args[1],
        thresholds: {
          maxAcceptQueue: Number(args[2]),
          maxHostMemoryUsedPercent: Number(args[3]),
          maxLoadPerCpuPercent: Number(args[4]),
          consecutiveSamples: Number(args[5]),
        },
        restartNodes: [Number(args[6]), Number(args[7])],
      });
      writeJson(report, true);
      if (!report.passed) process.exitCode = 1;
      return;
    }
    case 'devnet-health-audit':
      writeJson(createDevnetHealthAudit(args[0]), true);
      return;
    default:
      throw new Error(`unknown private-CG recovery helper command: ${command ?? '(missing)'}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
