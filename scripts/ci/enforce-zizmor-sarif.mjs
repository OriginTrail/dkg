#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function evaluateZizmorSarif({ scanOutcome, sarif }) {
  if (scanOutcome !== 'success') {
    return {
      ok: false,
      message: `zizmor did not complete successfully (outcome: ${scanOutcome || 'missing'})`,
    };
  }

  if (!sarif || typeof sarif !== 'object' || Array.isArray(sarif)) {
    return { ok: false, message: 'zizmor SARIF is not a JSON object' };
  }
  if (sarif.version !== '2.1.0' || !Array.isArray(sarif.runs) || sarif.runs.length === 0) {
    return { ok: false, message: 'zizmor SARIF is missing a valid 2.1.0 runs array' };
  }

  let findingCount = 0;
  for (const [index, run] of sarif.runs.entries()) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
      return { ok: false, message: `zizmor SARIF run ${index} is malformed` };
    }
    const driverName = run.tool?.driver?.name;
    if (typeof driverName !== 'string' || driverName.toLowerCase() !== 'zizmor') {
      return { ok: false, message: `zizmor SARIF run ${index} has an invalid tool driver` };
    }
    if (run.results !== undefined && !Array.isArray(run.results)) {
      return { ok: false, message: `zizmor SARIF run ${index} has a non-array results field` };
    }
    findingCount += run.results?.length ?? 0;
  }

  if (findingCount > 0) {
    return {
      ok: false,
      findingCount,
      message: `zizmor reported ${findingCount} finding${findingCount === 1 ? '' : 's'}`,
    };
  }
  return { ok: true, findingCount: 0, message: 'zizmor SARIF contains no findings' };
}

export function parseZizmorSarifArguments(argv) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      sarif: { type: 'string' },
      'scan-outcome': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!options.sarif) throw new Error('--sarif is required');
  if (!options['scan-outcome']) throw new Error('--scan-outcome is required');
  return options;
}

export function runZizmorSarifGate(argv) {
  let options;
  try {
    options = parseZizmorSarifArguments(argv);
  } catch (error) {
    console.error(`::error title=zizmor gate configuration::${error.message}`);
    return 2;
  }

  let sarif;
  try {
    sarif = JSON.parse(fs.readFileSync(options.sarif, 'utf8'));
  } catch (error) {
    console.error(`::error title=zizmor SARIF unreadable::${error.message}`);
    return 2;
  }

  const verdict = evaluateZizmorSarif({
    scanOutcome: options['scan-outcome'],
    sarif,
  });
  if (!verdict.ok) {
    console.error(`::error title=zizmor gate failed::${verdict.message}`);
    return 1;
  }
  console.log(verdict.message);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runZizmorSarifGate(process.argv.slice(2));
}
