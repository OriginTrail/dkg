#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderCpuProfileFlamegraphHtml,
  renderProfileIndexHtml,
} from './support/cpu-profile-report.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = resolve(rootDir, 'bench/results/profiles');
const esbenchBin = resolve(rootDir, 'node_modules/esbench/lib/host/cli.js');

if (!existsSync(esbenchBin)) {
  console.error(`ESBench CLI was not found at ${relativeFromRoot(esbenchBin)}. Run pnpm install first.`);
  process.exit(1);
}

await mkdir(profileDir, { recursive: true });

const createdAt = new Date().toISOString();
const profileName = `publish-async-get-${createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.cpuprofile`;
const profilePath = resolve(profileDir, profileName);
const reportJsonName = profileName.replace(/\.cpuprofile$/, '.esbench.json');
const reportHtmlName = profileName.replace(/\.cpuprofile$/, '.esbench.html');
const reportJsonPath = resolve(profileDir, reportJsonName);
const reportHtmlPath = resolve(profileDir, reportHtmlName);
const profileArgs = [
  '--cpu-prof',
  '--cpu-prof-dir',
  profileDir,
  '--cpu-prof-name',
  profileName,
  esbenchBin,
  '--config',
  'esbench.config.mjs',
  ...process.argv.slice(2),
];
const env = {
  ...process.env,
  ESBENCH_HTML: process.env.ESBENCH_HTML ?? '1',
  ESBENCH_RESULT: process.env.ESBENCH_RESULT ?? reportJsonPath,
  ESBENCH_HTML_FILE: process.env.ESBENCH_HTML_FILE ?? reportHtmlPath,
};

console.log(`[bench:profile] payload sizes: ${env.DKG_ESBENCH_PAYLOAD_SIZES || '10kb,100kb,2mb,200mb'}`);
console.log(`[bench:profile] writing CPU profile: ${relativeFromRoot(profilePath)}`);
console.log(`[bench:profile] writing ESBench report: ${relativeFromRoot(reportHtmlPath)}`);

const exitCode = await runNode(profileArgs, env);
if (exitCode !== 0) process.exit(exitCode);

const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const flamegraphName = profileName.replace(/\.cpuprofile$/, '.flamegraph.html');
const flamegraphPath = resolve(profileDir, flamegraphName);
await writeFile(flamegraphPath, renderCpuProfileFlamegraphHtml(profile, {
  title: 'DKG publish/async/get CPU flame graph',
  profileName,
  generatedAt: createdAt,
  benchmarkReportHref: `./${reportHtmlName}`,
  rawProfileHref: `./${profileName}`,
}), 'utf8');

await runMethodAnalysis(env);
await writeProfileIndex();
await linkExistingBenchmarkReports();

console.log(`[bench:profile] wrote flame graph: ${relativeFromRoot(flamegraphPath)}`);
console.log(`[bench:profile] wrote profile index: ${relativeFromRoot(resolve(profileDir, 'index.html'))}`);

function runNode(args, env) {
  return new Promise((resolveExitCode) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(error);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[bench:profile] profiler run exited from signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

async function writeProfileIndex() {
  const files = await readdir(profileDir);
  const entries = [];

  for (const file of files) {
    if (!file.endsWith('.cpuprofile')) continue;
    const profileFile = resolve(profileDir, file);
    const info = await stat(profileFile);
    const flamegraphName = file.replace(/\.cpuprofile$/, '.flamegraph.html');
    const reportHtmlName = file.replace(/\.cpuprofile$/, '.esbench.html');
    const reportJsonFile = resolve(profileDir, file.replace(/\.cpuprofile$/, '.esbench.json'));
    entries.push({
      createdAt: info.mtime.toISOString(),
      esbenchReportHref: `./${reportHtmlName}`,
      esbenchReportName: reportHtmlName,
      flamegraphHref: `./${flamegraphName}`,
      flamegraphName,
      profileHref: `./${file}`,
      profileName: file,
      payloadSizes: await readProfilePayloadSizes(reportJsonFile),
      sizeBytes: info.size,
    });
  }

  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await writeFile(resolve(profileDir, 'index.html'), renderProfileIndexHtml(entries, {
    benchmarkReportHref: '../latest.html',
  }), 'utf8');
}

async function runMethodAnalysis(env) {
  const exitCode = await runCommand(process.execPath, ['--experimental-strip-types', 'bench/analyze-publish-async-get.ts'], env);
  if (exitCode !== 0) {
    throw new Error(`Method analysis failed with exit code ${exitCode}`);
  }
}

async function readProfilePayloadSizes(reportJsonFile) {
  try {
    const report = JSON.parse(await readFile(reportJsonFile, 'utf8'));
    for (const records of Object.values(report)) {
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        const paramDef = Array.isArray(record?.paramDef) ? record.paramDef : [];
        const payloadParam = paramDef.find((param) => Array.isArray(param) && param[0] === 'payloadSize');
        if (Array.isArray(payloadParam?.[1])) return payloadParam[1].join(',');
      }
    }
  } catch {
    // Older local profile artifacts may not have a companion ESBench JSON file.
  }

  return process.env.DKG_ESBENCH_PAYLOAD_SIZES || '10kb,100kb,2mb,200mb';
}

async function linkExistingBenchmarkReports() {
  const {
    addLinkedReportNavigation,
    publishAsyncGetPages,
  } = await import('../esbench.config.mjs');
  const reportFiles = [
    'bench/results/latest.html',
    ...publishAsyncGetPages.map(([, file]) => file),
  ];
  const targets = [
    ['Combined report', 'bench/results/latest.html'],
    ...publishAsyncGetPages,
  ];
  if (existsSync(resolve(rootDir, 'bench/results/profiles/index.html'))) {
    targets.push(['CPU profiles', 'bench/results/profiles/index.html']);
  }
  if (existsSync(resolve(rootDir, 'bench/results/profiles/method-analysis.latest.html'))) {
    targets.push(['Method analysis', 'bench/results/profiles/method-analysis.latest.html']);
  }

  for (const file of reportFiles) {
    const reportPath = resolve(rootDir, file);
    if (!existsSync(reportPath)) continue;
    const html = await readFile(reportPath, 'utf8');
    await writeFile(reportPath, addLinkedReportNavigation(html, file, targets), 'utf8');
  }
}

function runCommand(command, args, env) {
  return new Promise((resolveExitCode) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(error);
      resolveExitCode(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[bench:profile] command exited from signal ${signal}`);
        resolveExitCode(1);
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

function relativeFromRoot(path) {
  return path.startsWith(rootDir) ? path.slice(rootDir.length + 1) : basename(path);
}
