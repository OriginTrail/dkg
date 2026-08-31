#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DKG_LOCAL_LLM_SYSTEM_CONTEXT_VERSION,
  DkgLocalLlmRuntime,
  TextInteractionTrace,
} from '../dist/index.js';
import {
  GuardedBenchmarkMcp,
  contentText,
  markdownReport,
  modelAssetLifecyclePass,
  modelCallsSince,
  phaseReport,
  successfulCalls,
} from './harness.mjs';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const DEFAULT_LLAMA_URL = 'http://127.0.0.1:8080/v1/chat/completions';

function timestampSlug() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14).toLowerCase();
}

function positiveInteger(label, raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

export function parseBenchmarkArgs(argv) {
  const stamp = timestampSlug();
  const options = {
    allowWrite: false,
    graphId: `dkg-llm-bench-${stamp}`,
    assetName: `model-authored-families-${stamp}`,
    label: 'dkg-local-llm',
    model: 'local-model',
    llamaUrl: DEFAULT_LLAMA_URL,
    out: undefined,
    maxToolCalls: 5,
    maxTools: 8,
    maxTokens: 1024,
    requestTimeoutMs: 120_000,
  };
  const values = new Map([
    ['--graph-id', 'graphId'],
    ['--asset-name', 'assetName'],
    ['--label', 'label'],
    ['--model', 'model'],
    ['--llama-url', 'llamaUrl'],
    ['--out', 'out'],
    ['--max-tool-calls', 'maxToolCalls'],
    ['--max-tools', 'maxTools'],
    ['--max-tokens', 'maxTokens'],
    ['--request-timeout-ms', 'requestTimeoutMs'],
  ]);
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--allow-write') {
      options.allowWrite = true;
      continue;
    }
    const key = values.get(argv[index]);
    if (!key) throw new Error(`Unknown option: ${argv[index]}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${argv[index]}`);
    options[key] = argv[++index];
  }
  options.maxToolCalls = positiveInteger('--max-tool-calls', options.maxToolCalls, 5);
  options.maxTools = positiveInteger('--max-tools', options.maxTools, 8);
  options.maxTokens = positiveInteger('--max-tokens', options.maxTokens, 1024);
  options.requestTimeoutMs = positiveInteger('--request-timeout-ms', options.requestTimeoutMs, 120_000);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.graphId)) {
    throw new Error('--graph-id must be a lowercase DKG slug.');
  }
  if (!options.allowWrite) {
    throw new Error('This benchmark creates persistent local DKG data. Re-run with --allow-write.');
  }
  options.fixtureAssetName = `${options.assetName}-fixture`;
  return options;
}

function fixtureQuads() {
  return [
    { subject: 'urn:dkg-llm-bench:model:Model01', predicate: 'rdfs:label', object: '"Benchmark Model 01"' },
    { subject: 'urn:dkg-llm-bench:model:Model01', predicate: 'rdf:type', object: 'urn:dkg-llm-bench:class:ModelFamily' },
    { subject: 'urn:dkg-llm-bench:model:Model01', predicate: 'schema:category', object: '"decoder-only"' },
    { subject: 'urn:dkg-llm-bench:model:Model02', predicate: 'rdfs:label', object: '"Benchmark Model 02"' },
    { subject: 'urn:dkg-llm-bench:model:Model02', predicate: 'rdf:type', object: 'urn:dkg-llm-bench:class:ModelFamily' },
    { subject: 'urn:dkg-llm-bench:model:Model02', predicate: 'schema:category', object: '"state-space"' },
  ];
}

function canonicalCatalogInput(target) {
  return {
    projectId: target.graphId,
    name: 'Models by category',
    description: 'Return benchmark model-family labels for one category.',
    sparql: 'SELECT ?model ?label WHERE { ?model <rdf:type> <urn:dkg-llm-bench:class:ModelFamily> . ?model <schema:category> {{category}} . ?model <rdfs:label> ?label } ORDER BY ?model',
    subGraph: 'model-families',
    catalogSlug: 'local-llm-benchmark',
    catalogName: 'Local LLM benchmark',
    parameters: [{ name: 'category', type: 'string', required: true }],
    view: 'working-memory',
  };
}

async function ensureContextGraph(mcp, target) {
  await mcp.callFixture('dkg_context_graph_create', {
    id: target.graphId,
    name: `Local LLM benchmark ${target.graphId}`,
    description: 'Persistent local data created by the DKG local-LLM benchmark.',
    sharing: 'invite-only',
    contribution: 'curators-only',
  });
}

async function ensureSubGraphs(mcp, target) {
  for (const subGraphName of ['model-families', 'model-capabilities']) {
    await mcp.callFixture('dkg_sub_graph_create', {
      contextGraphId: target.graphId,
      subGraphName,
    });
  }
}

async function ensureFixtureAsset(mcp, target) {
  await mcp.callFixture('dkg_knowledge_asset_create', {
    projectId: target.graphId,
    subGraphName: 'model-families',
    name: target.fixtureAssetName,
  });
  await mcp.callFixture('dkg_knowledge_asset_write', {
    projectId: target.graphId,
    subGraphName: 'model-families',
    name: target.fixtureAssetName,
    quads: fixtureQuads(),
  });
  await mcp.callFixture('dkg_knowledge_asset_finalize', {
    projectId: target.graphId,
    subGraphName: 'model-families',
    name: target.fixtureAssetName,
  });
}

async function ensureCatalog(mcp, target) {
  const result = await mcp.callFixture('dkg_query_catalog_save', canonicalCatalogInput(target));
  return result.structuredContent?.selector
    ?? 'model-families/local-llm-benchmark/models-by-category';
}

function hasSuccessful(calls, name) {
  return successfulCalls(calls, name).length > 0;
}

function callsContain(calls, name, pattern) {
  return successfulCalls(calls, name).some((call) => pattern.test(call.text));
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyPersistenceVerification(report, verification) {
  report.persistenceVerification = verification;
  if (!verification.pass) {
    report.pass = false;
    report.error ??= `Persistence verification failed: ${verification.detail || 'expected DKG state was not found'}`;
  }
  return report;
}

function buildPhases(options, state) {
  const target = state.target;
  return [
    {
      id: '01-create-context-graph',
      group: 'core-write',
      prompt: `Create a private DKG context graph named "Local LLM Benchmark" with the exact id ${target.graphId}. Use invite-only sharing and curators-only contribution.`,
      evaluate: ({ calls }) => hasSuccessful(calls, 'dkg_context_graph_create'),
      verify: async () => {
        const result = await state.mcp.callFixture('dkg_list_context_graphs', { scope: 'all' });
        const pass = new RegExp(`\\b${escapedPattern(target.graphId)}\\b`).test(contentText(result));
        return { pass, detail: pass ? 'Context Graph is discoverable.' : 'Created Context Graph is not discoverable.' };
      },
      after: () => ensureContextGraph(state.mcp, target),
    },
    {
      id: '02-create-subgraphs',
      group: 'core-write',
      prompt: `In DKG context graph ${target.graphId}, create both subgraphs model-families and model-capabilities. Confirm both through tool evidence.`,
      evaluate: ({ calls }) => {
        const names = new Set(successfulCalls(calls, 'dkg_sub_graph_create').map((call) => call.args.subGraphName));
        return names.has('model-families') && names.has('model-capabilities');
      },
      verify: async () => {
        const result = await state.mcp.callFixture('dkg_sub_graph_list', { projectId: target.graphId });
        const text = contentText(result);
        const pass = /model-families/.test(text) && /model-capabilities/.test(text);
        return { pass, detail: pass ? 'Both subgraphs are listed.' : 'One or both subgraphs are absent.' };
      },
      after: () => ensureSubGraphs(state.mcp, target),
    },
    {
      id: '03-model-authored-asset',
      group: 'core-write',
      prompt: `In DKG context graph ${target.graphId}, subgraph model-families, create knowledge asset ${target.assetName}. Add at least 10 useful RDF triples about distinct local LLM model families using stable urn: subjects, rdfs:label, rdf:type, and schema:description or schema:category, then finalize the asset. Do not share or publish it.`,
      evaluate: ({ calls }) => modelAssetLifecyclePass(calls, target, 10),
      verify: async () => {
        const result = await state.mcp.callFixture('dkg_knowledge_asset_query', {
          projectId: target.graphId,
          subGraphName: 'model-families',
          name: target.assetName,
        });
        const text = contentText(result);
        const count = Number(text.match(/(\d+) quad\(s\)/i)?.[1] ?? 0);
        const pass = count >= 10
          && /rdfs:label/.test(text)
          && /rdf:type/.test(text)
          && /schema:(?:description|category)/.test(text);
        return {
          pass,
          detail: pass
            ? `Model-authored asset persisted with ${count} quads.`
            : `Model-authored asset persistence did not prove the requested RDF shape (${count} quads found).`,
        };
      },
      after: () => ensureFixtureAsset(state.mcp, target),
    },
    {
      id: '04-retrieve-asset',
      group: 'core-read',
      prompt: `Retrieve DKG knowledge asset ${target.fixtureAssetName} from context graph ${target.graphId}, subgraph model-families, and report the two model labels using only returned evidence.`,
      evaluate: ({ calls }) => callsContain(calls, 'dkg_knowledge_asset_query', /Benchmark Model 01/)
        || callsContain(calls, 'dkg_query', /Benchmark Model 01/),
    },
    {
      id: '05-raw-sparql-retrieval',
      group: 'core-read',
      prompt: `Use a DKG SPARQL SELECT in ${target.graphId}/model-families Working Memory to return ?model and ?category for subjects whose rdf:type is urn:dkg-llm-bench:class:ModelFamily. Order by ?model.`,
      evaluate: ({ calls }) => callsContain(calls, 'dkg_query', /Benchmark Model 01|Model01/),
    },
    {
      id: '06-save-parametric-catalog-query',
      group: 'catalog-write',
      prompt: `Save one immutable parameterized DKG query-catalog entry in context graph ${target.graphId}. Name it "Models by category", use catalog slug local-llm-benchmark, subgraph model-families, Working Memory view, and one required string parameter named category. Its SELECT must return ?model and ?label for ModelFamily entities whose schema:category equals {{category}}, ordered by model. Do not run or publish anything else.`,
      evaluate: ({ calls }) => successfulCalls(calls, 'dkg_query_catalog_save').some((call) =>
        call.args.catalogSlug === 'local-llm-benchmark'
        && call.args.subGraph === 'model-families'
        && call.args.parameters?.some((parameter) => parameter.name === 'category')),
      verify: async () => {
        const result = await state.mcp.callFixture('dkg_query_catalog_list', {
          projectId: target.graphId,
          catalogSlug: 'local-llm-benchmark',
        });
        const items = Array.isArray(result.structuredContent?.items)
          ? result.structuredContent.items
          : [];
        const match = items.find((item) => item.name === 'Models by category'
          && item.subGraph === 'model-families'
          && item.view === 'working-memory'
          && item.parameters?.some((parameter) => parameter.name === 'category' && parameter.type === 'string'));
        if (typeof match?.selector === 'string') state.catalogSelector = match.selector;
        return {
          pass: Boolean(match),
          detail: match ? `Saved selector ${match.selector}.` : 'Saved catalog entry was not independently readable.',
        };
      },
      after: async () => { state.catalogSelector = await ensureCatalog(state.mcp, target); },
    },
    {
      id: '07-list-query-catalog',
      group: 'catalog-read',
      prompt: `List the saved DKG query catalog entries in context graph ${target.graphId}. Find the exact selector and parameter declaration for "Models by category".`,
      evaluate: ({ calls }) => callsContain(calls, 'dkg_query_catalog_list', /Models by category|models-by-category/),
    },
    {
      id: '08-run-parametric-catalog-query',
      group: 'catalog-read',
      prompt: () => `Run the saved DKG query ${state.catalogSelector} in context graph ${target.graphId} with category set to decoder-only. Report only the returned model label.`,
      evaluate: ({ calls }) => callsContain(calls, 'dkg_query_catalog_run', /Benchmark Model 01/),
    },
    {
      id: '09-holdout-ask',
      group: 'holdout',
      prompt: `Use DKG SPARQL ASK against ${target.graphId}/model-families Working Memory to verify that urn:dkg-llm-bench:model:Model02 has schema:category "state-space".`,
      evaluate: ({ calls }) => callsContain(calls, 'dkg_query', /true/i),
    },
    {
      id: '10-holdout-entity',
      group: 'holdout',
      prompt: `Get DKG entity urn:dkg-llm-bench:model:Model01 from context graph ${target.graphId}, subgraph model-families, and describe its one-hop facts from evidence.`,
      evaluate: ({ calls }) => callsContain(calls, 'dkg_get_entity', /Benchmark Model 01/),
    },
    {
      id: '11-holdout-node-status',
      group: 'holdout',
      prompt: 'What is the status of the DKG node right now?',
      evaluate: ({ calls }) => hasSuccessful(calls, 'dkg_status'),
    },
    {
      id: '12-holdout-chat-no-tool',
      group: 'holdout',
      prompt: 'Hello there',
      evaluate: ({ calls, result }) => calls.length === 0 && Boolean(result?.answer),
    },
    {
      id: '13-holdout-catalog-followup',
      group: 'holdout',
      prompt: `Run that saved query again for category state-space in context graph ${target.graphId}.`,
      evaluate: ({ calls }) => callsContain(calls, 'dkg_query_catalog_run', /Benchmark Model 02/),
    },
  ];
}

async function verifyDkg(mcp, target, selector) {
  const checks = [
    {
      name: 'both subgraphs exist',
      call: ['dkg_sub_graph_list', { projectId: target.graphId }],
      validate: (result) => /model-families/.test(contentText(result)) && /model-capabilities/.test(contentText(result)),
    },
    {
      name: 'fixture asset contains RDF',
      call: ['dkg_knowledge_asset_query', {
        projectId: target.graphId,
        subGraphName: 'model-families',
        name: target.fixtureAssetName,
      }],
      validate: (result) => /Benchmark Model 01/.test(contentText(result)) && /Benchmark Model 02/.test(contentText(result)),
    },
    {
      name: 'parametric catalog entry is listed',
      call: ['dkg_query_catalog_list', { projectId: target.graphId, catalogSlug: 'local-llm-benchmark' }],
      validate: (result) => /Models by category|models-by-category/.test(contentText(result)),
    },
    {
      name: 'parametric catalog execution returns decoder-only fixture',
      call: ['dkg_query_catalog_run', {
        projectId: target.graphId,
        selector,
        parameters: { category: 'decoder-only' },
      }],
      validate: (result) => /Benchmark Model 01/.test(contentText(result)),
    },
  ];
  const records = [];
  for (const check of checks) {
    try {
      const result = await mcp.callFixture(check.call[0], check.call[1]);
      records.push({ name: check.name, pass: check.validate(result), error: null });
    } catch (error) {
      records.push({ name: check.name, pass: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return records;
}

async function main() {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString();
  const outputDir = path.resolve(options.out ?? path.join(
    PACKAGE_ROOT,
    'benchmark-results',
    `${timestamp.replace(/[:.]/g, '-')}-${options.label}`,
  ));
  await fs.mkdir(outputDir, { recursive: true });
  const trace = await TextInteractionTrace.create({ logFile: path.join(outputDir, 'interaction.log') });
  const cliPath = path.resolve(process.env.DKG_CLI_PATH?.trim()
    || path.join(REPO_ROOT, 'packages/cli/dist/cli.js'));
  const dkgHome = path.resolve(process.env.DKG_HOME?.trim() || path.join(os.homedir(), 'dkg-local'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      DKG_HOME: dkgHome,
      DKG_PROJECT: options.graphId,
    },
  });
  transport.stderr?.on('data', (chunk) => {
    const line = String(chunk).trimEnd();
    if (line) {
      process.stderr.write(`[dkg-mcp] ${line}\n`);
      void trace.write('DKG MCP STDERR', line);
    }
  });

  const client = new Client({ name: 'dkg-local-llm-real-benchmark', version: '10.0.15' });
  const target = {
    graphId: options.graphId,
    assetName: options.assetName,
    fixtureAssetName: options.fixtureAssetName,
  };
  try {
    await client.connect(transport);
    const guardedMcp = new GuardedBenchmarkMcp(client, target);
    const runtime = await DkgLocalLlmRuntime.create({
      mcp: guardedMcp,
      llamaUrl: options.llamaUrl,
      model: options.model,
      projectId: options.graphId,
      allowWrite: true,
      maxToolCalls: options.maxToolCalls,
      maxToolsPerTurn: options.maxTools,
      maxTokens: options.maxTokens,
      requestTimeoutMs: options.requestTimeoutMs,
      trace,
    });
    const state = {
      target,
      mcp: guardedMcp,
      catalogSelector: 'model-families/local-llm-benchmark/models-by-category',
    };
    const phases = [];
    for (const phase of buildPhases(options, state)) {
      process.stderr.write(`[benchmark] ${phase.id}\n`);
      const prompt = typeof phase.prompt === 'function' ? phase.prompt() : phase.prompt;
      const effectivePhase = { ...phase, prompt };
      const offset = guardedMcp.records.length;
      let result;
      let error;
      try {
        result = await runtime.run(prompt);
      } catch (caught) {
        error = caught;
      }
      const calls = modelCallsSince(guardedMcp, offset);
      const report = phaseReport(effectivePhase, result, calls, error);
      if (phase.verify) {
        try {
          applyPersistenceVerification(report, await phase.verify());
        } catch (verificationError) {
          applyPersistenceVerification(report, {
            pass: false,
            detail: verificationError instanceof Error ? verificationError.message : String(verificationError),
          });
        }
      }
      phases.push(report);
      if (phase.after) {
        try {
          await phase.after();
        } catch (fixtureError) {
          phases.at(-1).pass = false;
          phases.at(-1).error = `Fixture repair failed: ${fixtureError instanceof Error ? fixtureError.message : String(fixtureError)}`;
          throw fixtureError;
        }
      }
    }
    const verifications = await verifyDkg(guardedMcp, target, state.catalogSelector);
    const metadata = {
      timestamp,
      label: options.label,
      model: options.model,
      llamaUrl: options.llamaUrl,
      graphId: options.graphId,
      assetName: options.assetName,
      fixtureAssetName: options.fixtureAssetName,
      dkgHome,
      cliPath,
      systemContextVersion: DKG_LOCAL_LLM_SYSTEM_CONTEXT_VERSION,
      traceFile: trace.filePath,
      scenarios: phases.length,
    };
    const results = {
      metadata,
      summary: {
        passed: phases.filter((phase) => phase.pass).length,
        total: phases.length,
        corePassed: phases.filter((phase) => phase.group !== 'holdout' && phase.pass).length,
        coreTotal: phases.filter((phase) => phase.group !== 'holdout').length,
        holdoutPassed: phases.filter((phase) => phase.group === 'holdout' && phase.pass).length,
        holdoutTotal: phases.filter((phase) => phase.group === 'holdout').length,
        verificationPassed: verifications.filter((item) => item.pass).length,
        verificationTotal: verifications.length,
      },
      phases,
      verifications,
      allMcpCalls: guardedMcp.records,
    };
    const report = markdownReport(metadata, phases, verifications);
    await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, 'report.md'), report);
    process.stdout.write(`${report}\nResults: ${outputDir}\n`);
    if (results.summary.passed !== results.summary.total
      || results.summary.verificationPassed !== results.summary.verificationTotal) {
      process.exitCode = 1;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

const direct = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (direct) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
