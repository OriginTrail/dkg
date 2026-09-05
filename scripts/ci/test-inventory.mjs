#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { validateCiLaneWorkflow } from '../lib/ci-lane-workflow.mjs';
import { COVERAGE_JOBS } from '../lib/coverage-artifacts.mjs';
import { isTestSurface, secondaryRoutes } from '../lib/test-inventory-surface.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const owners = new Map();
function own(file, lane, command, cadence, metadata = {}) {
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  const entries = owners.get(relative) ?? [];
  const packageName = relative.startsWith('packages/') ? relative.split('/')[1] : undefined;
  const layer = lane === 'archive' ? 'historical' : lane.includes('browser') ? 'browser' : lane === 'solidity' || lane === 'evm-integration' ? 'chain integration' : lane === 'python' ? 'Python contract' : lane === 'devnet' || lane === 'tornado-blazegraph' ? 'system' : 'unit/component';
  const prerequisites = lane === 'tornado-blazegraph' ? ['built runtime packages', 'native Oxigraph binary', 'BLAZEGRAPH_TEST_URL'] : lane.includes('browser') || lane === 'devnet' ? ['built runtime packages', 'isolated local devnet', ...(lane.includes('browser') ? ['Playwright Chromium'] : [])] : lane === 'python' ? ['Python 3', 'pytests/requirements.txt'] : lane === 'solidity' || lane === 'evm-integration' ? ['Hardhat artifacts', 'free local port'] : ['pnpm frozen install', 'built workspace dependencies'];
  entries.push({ lane, owner: packageName ? `packages/${packageName}` : relative.split('/')[0], layer: metadata.layer ?? layer, command, cadence, prerequisites: metadata.prerequisites ?? prerequisites }); owners.set(relative, entries);
}

function secondaryCommand(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (/['"]node:test['"]/.test(source)) return `node --experimental-sqlite --import tsx --test ${file}`;
  let directory = path.dirname(file);
  while (directory !== '.') {
    if (fs.existsSync(path.join(root, directory, 'vitest.config.ts'))) return `pnpm --dir ${directory} exec vitest run --config vitest.config.ts ${path.relative(directory, file)}`;
    const manifest = path.join(root, directory, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts?.test) return `pnpm --dir ${directory} test`;
    directory = path.dirname(directory);
  }
  throw new Error(`secondary test needs an explicit runnable command: ${file}`);
}
try {
  validateCiLaneWorkflow(parseYaml(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')));
  const packages = Object.values(COVERAGE_JOBS).flatMap(Object.keys).sort();
  const configured = fs.readdirSync(path.join(root, 'packages')).filter((name) => fs.existsSync(path.join(root, 'packages', name, 'vitest.config.ts'))).sort();
  if (JSON.stringify(packages) !== JSON.stringify(configured)) throw new Error('package configs and required coverage jobs disagree');
  for (const name of packages) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8'));
    if (Object.values(manifest.scripts ?? {}).some((command) => command.includes('--passWithNoTests'))) throw new Error(`${name}: populated packages must fail on empty test discovery`);
    const output = execFileSync(pnpm, ['--dir', `packages/${name}`, 'exec', 'vitest', 'list', '--filesOnly', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const files = JSON.parse(output);
    if (!files.length) throw new Error(`${name}: discovery returned no files`);
    const lane = Object.entries(COVERAGE_JOBS).find(([, entries]) => name in entries)[0];
    for (const file of files) own(file.file, lane, `pnpm --dir packages/${name} exec vitest run`, 'required');
  }
  const evm = fs.readFileSync(path.join(root, 'scripts/test-evm-integration.sh'), 'utf8');
  for (const [, file] of evm.matchAll(/^  "(packages\/[^"\n]+\.test\.ts)"/gm)) own(file, 'evm-integration', 'pnpm test:evm', 'required');
  const registrations = JSON.parse(fs.readFileSync(path.join(root, 'test-policy/test-routes.json'), 'utf8'));
  const tracked = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0'))].filter(isTestSurface).filter((file) => fs.existsSync(path.join(root, file)));
  for (const [file, route] of secondaryRoutes(tracked, registrations)) {
    if (!owners.has(file)) own(file, route.lane, route.command === 'resolve' ? secondaryCommand(file) : route.command, route.cadence, route);
  }
  const missing = tracked.filter((file) => !owners.has(file));
  const report = tracked.sort().map((file) => ({ file, execution: owners.get(file) ?? [] }));
  fs.writeFileSync(path.join(root, 'test-inventory.json'), JSON.stringify(report, null, 2) + '\n');
  if (missing.length) throw new Error(`tests without an execution route:\n${missing.join('\n')}`);
  console.log(`Verified ${report.length} test files across ${packages.length} Vitest packages and explicit secondary systems.`);
} catch (error) {
  console.error(`test inventory: ${error.message}`); process.exitCode = 1;
}
