#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createPayload,
  getSparql,
  validateQueryContainsMarker,
} from '../packages/cli/src/benchmark/publish-get/payload.ts';
import type {
  BenchmarkConfig,
  BenchmarkPayload,
} from '../packages/cli/src/benchmark/publish-get/types.ts';
import {
  GENERATED_PAYLOAD_SIZES,
} from './publish-async-get.bench.ts';
import { LayeredDkgBenchmarkClient } from './support/layered-dkg-client.ts';

type PayloadSizeLabel = (typeof GENERATED_PAYLOAD_SIZES)[number]['label'];
type TracePhase = 'setup' | 'measured' | 'validation' | 'cleanup';

interface MethodTrace {
  flow: string;
  payloadSize: PayloadSizeLabel;
  phase: TracePhase;
  method: string;
  invokes: string[];
  detail: string;
  durationMs: number;
  success: boolean;
  context: Record<string, unknown>;
  error?: string;
}

interface FlowAnalysis {
  flow: string;
  payloadSize: PayloadSizeLabel;
  totalMs: number;
  measuredMs: number;
  traces: MethodTrace[];
}

interface MethodAnalysisReport {
  benchmark: 'publish-async-get-method-analysis';
  generatedAt: string;
  payloadSizes: PayloadSizeLabel[];
  flows: FlowAnalysis[];
}

const DEFAULT_OUTPUT_DIR = 'bench/results/profiles';
const PUBLISH_ASYNC_GET_PAGES: Array<[string, string]> = [
  ['get/read retrieval', 'bench/results/publish-async-get/get-read-retrieval.html'],
  ['synchronous publish with finalization', 'bench/results/publish-async-get/sync-publish-finalization.html'],
  ['asynchronous publish enqueue and finalization', 'bench/results/publish-async-get/async-publish-finalization.html'],
  ['upload payload to local working memory', 'bench/results/publish-async-get/working-memory-upload.html'],
  ['lift local working memory to shared working memory', 'bench/results/publish-async-get/working-to-shared-memory.html'],
];

export async function main(): Promise<void> {
  const outputDir = resolve(process.cwd(), process.env.DKG_BENCH_ANALYSIS_DIR ?? DEFAULT_OUTPUT_DIR);
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const report = await createMethodAnalysisReport(resolvePayloadSizeLabels(), generatedAt);
  const html = renderMethodAnalysisHtml(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;

  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, `method-analysis-${stamp}.json`), json, 'utf8');
  await writeFile(resolve(outputDir, `method-analysis-${stamp}.html`), html, 'utf8');
  await writeFile(resolve(outputDir, 'method-analysis.latest.json'), json, 'utf8');
  await writeFile(resolve(outputDir, 'method-analysis.latest.html'), html, 'utf8');
  await linkExistingBenchmarkReports();

  console.log(`[bench:analysis] wrote ${relativePath(resolve(outputDir, 'method-analysis.latest.html'))}`);
}

export async function createMethodAnalysisReport(
  payloadSizes = resolvePayloadSizeLabels(),
  generatedAt = new Date().toISOString(),
): Promise<MethodAnalysisReport> {
  const flows: FlowAnalysis[] = [];
  for (const payloadSize of payloadSizes) {
    const config = createConfig(payloadSize);
    flows.push(await analyzeGetFlow(config, payloadSize));
    flows.push(await analyzeSyncPublishFlow(config, payloadSize));
    flows.push(await analyzeAsyncPublishFlow(config, payloadSize));
    flows.push(await analyzeWorkingMemoryUploadFlow(config, payloadSize));
    flows.push(await analyzeWorkingToSharedMemoryFlow(config, payloadSize));
  }

  return {
    benchmark: 'publish-async-get-method-analysis',
    generatedAt,
    payloadSizes,
    flows,
  };
}

export function renderMethodAnalysisHtml(report: MethodAnalysisReport): string {
  const sections = report.payloadSizes.map((payloadSize) => {
    const flows = report.flows.filter((flow) => flow.payloadSize === payloadSize);
    return `<section class="payload-section">
      <h2>${escapeHtml(payloadSize)}</h2>
      ${flows.map(renderFlowSection).join('\n')}
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DKG Benchmark Method Analysis</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { background: #f8fafc; color: #111827; margin: 0; }
    header { background: #111827; color: #f9fafb; padding: 18px 24px; }
    main { padding: 22px 24px 40px; }
    a { color: #1d4ed8; }
    header a { color: #bfdbfe; }
    .nav { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    .nav a { border: 1px solid #4b5563; border-radius: 4px; color: #f9fafb; padding: 5px 9px; text-decoration: none; }
    .meta { color: #d1d5db; font-size: 13px; margin-top: 6px; }
    .payload-section { margin-bottom: 28px; }
    .flow { background: white; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 18px; padding: 16px; }
    .flow-summary { color: #4b5563; display: flex; flex-wrap: wrap; font-size: 13px; gap: 16px; margin: 6px 0 12px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: #374151; font-size: 12px; text-transform: uppercase; }
    code { background: #eef2ff; border-radius: 4px; padding: 1px 4px; }
    .phase { border-radius: 4px; color: white; display: inline-block; min-width: 72px; padding: 2px 6px; text-align: center; }
    .setup { background: #475569; }
    .measured { background: #2563eb; }
    .validation { background: #059669; }
    .cleanup { background: #7c3aed; }
    .bar { background: #dbeafe; border-radius: 999px; height: 8px; min-width: 80px; overflow: hidden; }
    .bar span { background: #2563eb; display: block; height: 100%; }
    .context { color: #4b5563; font-size: 12px; max-width: 360px; }
  </style>
</head>
<body>
  <header>
    <h1>DKG Benchmark Method Analysis</h1>
    <div class="meta">Generated ${escapeHtml(report.generatedAt)}. Durations are wall-clock timings from one representative traced run per flow and payload size.</div>
    <nav class="nav" aria-label="Benchmark analysis links">
      <a href="../latest.html">ESBench report</a>
      <a href="./index.html">CPU profiles</a>
      <a href="./method-analysis.latest.json">Raw method trace JSON</a>
    </nav>
  </header>
  <main>
    ${sections}
  </main>
</body>
</html>
`;
}

async function analyzeGetFlow(config: BenchmarkConfig, payloadSize: PayloadSizeLabel): Promise<FlowAnalysis> {
  const client = new LayeredDkgBenchmarkClient();
  return analyzeFlow('get/read retrieval', payloadSize, async (trace) => {
    const payload = traceSync(trace, 'setup', 'createPayload', [], 'Generate the asset to publish and read back.', () => (
      createPayload(config, `analysis-get-${payloadSize}`, 1, 'sync', false)
    ));
    await traceSharedMemoryWrite(trace, client, config, payload);
    await traceAsync(trace, 'setup', 'publishFromSharedMemory', ['promoteSharedRoot'], 'Finalize staged shared-memory content into verified memory for the read path.', () => (
      client.publishFromSharedMemory(config.contextGraphId, { rootEntities: [payload.rootEntity] }, false)
    ), { rootEntity: payload.rootEntity });
    const sparql = traceSync(trace, 'measured', 'getSparql', [], 'Build the read query for the published root entity.', () => getSparql(payload.rootEntity));
    const response = await traceAsync(trace, 'measured', 'query', ['layer'], 'Read the published marker from the configured memory view.', () => (
      client.query(sparql, config.contextGraphId, { view: config.getView })
    ), { view: config.getView, rootEntity: payload.rootEntity });
    traceSync(trace, 'validation', 'validateQueryContainsMarker', [], 'Verify the get result contains the expected benchmark marker.', () => (
      validateQueryContainsMarker(response.result, payload.marker)
    ));
    traceSync(trace, 'cleanup', 'clear', ['Map.clear'], 'Clear all in-memory layers after the representative run.', () => client.clear());
  });
}

async function analyzeSyncPublishFlow(config: BenchmarkConfig, payloadSize: PayloadSizeLabel): Promise<FlowAnalysis> {
  const client = new LayeredDkgBenchmarkClient();
  return analyzeFlow('synchronous publish with finalization', payloadSize, async (trace) => {
    const payload = traceSync(trace, 'setup', 'createPayload', [], 'Generate the payload for synchronous publish.', () => (
      createPayload(config, `analysis-sync-${payloadSize}`, 1, 'sync', false)
    ));
    await traceSharedMemoryWrite(trace, client, config, payload);
    await traceAsync(trace, 'measured', 'publishFromSharedMemory', ['promoteSharedRoot'], 'Synchronously finalize staged shared-memory content into verified memory.', () => (
      client.publishFromSharedMemory(config.contextGraphId, { rootEntities: [payload.rootEntity] }, false)
    ), { rootEntity: payload.rootEntity });
    traceSync(trace, 'cleanup', 'clear', ['Map.clear'], 'Clear all in-memory layers after the representative run.', () => client.clear());
  });
}

async function analyzeAsyncPublishFlow(config: BenchmarkConfig, payloadSize: PayloadSizeLabel): Promise<FlowAnalysis> {
  const client = new LayeredDkgBenchmarkClient();
  return analyzeFlow('asynchronous publish enqueue and finalization', payloadSize, async (trace) => {
    const payload = traceSync(trace, 'setup', 'createPayload', [], 'Generate the payload for async publish.', () => (
      createPayload(config, `analysis-async-${payloadSize}`, 1, 'async', false)
    ));
    const prepared = await traceSharedMemoryWrite(trace, client, config, payload);
    const shareOperationId = prepared.shareOperationId ?? '';
    const queued = await traceAsync(trace, 'measured', 'publisherEnqueue', ['publisherJobs.set'], 'Enqueue the publish request through the publisher runtime path.', () => (
      client.publisherEnqueue({
        contextGraphId: config.contextGraphId,
        shareOperationId,
        roots: [payload.rootEntity],
        namespace: config.namespace,
        scope: config.scope,
        authorityProofRef: config.authorityProofRef,
        swmId: 'swm-main',
        transitionType: 'CREATE',
        authorityType: 'owner',
      })
    ), { rootEntity: payload.rootEntity, shareOperationId });
    await traceAsync(trace, 'measured', 'publisherJob', ['promoteSharedRoot'], 'Poll the publisher job and finalize queued content.', () => (
      client.publisherJob(queued.jobId ?? '')
    ), { jobId: queued.jobId });
    traceSync(trace, 'cleanup', 'clear', ['Map.clear'], 'Clear all in-memory layers after the representative run.', () => client.clear());
  });
}

async function analyzeWorkingMemoryUploadFlow(config: BenchmarkConfig, payloadSize: PayloadSizeLabel): Promise<FlowAnalysis> {
  const client = new LayeredDkgBenchmarkClient();
  return analyzeFlow('upload payload to local working memory', payloadSize, async (trace) => {
    const payload = traceSync(trace, 'setup', 'createPayload', [], 'Generate the payload to upload into local working memory.', () => (
      createPayload(config, `analysis-upload-${payloadSize}`, 1, 'sync', false)
    ));
    await traceAsync(trace, 'measured', 'writeWorkingMemory', ['createMemoryRecord', 'uniqueSubjects', 'Map.set'], 'Write generated quads into local working memory.', () => (
      client.writeWorkingMemory(config.contextGraphId, payload.quads)
    ), payloadContext(payload));
    traceSync(trace, 'cleanup', 'clear', ['Map.clear'], 'Clear all in-memory layers after the representative run.', () => client.clear());
  });
}

async function analyzeWorkingToSharedMemoryFlow(config: BenchmarkConfig, payloadSize: PayloadSizeLabel): Promise<FlowAnalysis> {
  const client = new LayeredDkgBenchmarkClient();
  return analyzeFlow('lift local working memory to shared working memory', payloadSize, async (trace) => {
    const payload = traceSync(trace, 'setup', 'createPayload', [], 'Generate the payload to lift from local to shared memory.', () => (
      createPayload(config, `analysis-lift-${payloadSize}`, 1, 'sync', false)
    ));
    await traceAsync(trace, 'setup', 'writeWorkingMemory', ['createMemoryRecord', 'uniqueSubjects', 'Map.set'], 'Stage generated quads in local working memory.', () => (
      client.writeWorkingMemory(config.contextGraphId, payload.quads)
    ), payloadContext(payload));
    await traceAsync(trace, 'measured', 'liftWorkingMemoryToSharedMemory', ['Map.get', 'Map.set'], 'Lift the selected root from local working memory into shared working memory.', () => (
      client.liftWorkingMemoryToSharedMemory(config.contextGraphId, [payload.rootEntity])
    ), { rootEntity: payload.rootEntity });
    traceSync(trace, 'cleanup', 'clear', ['Map.clear'], 'Clear all in-memory layers after the representative run.', () => client.clear());
  });
}

async function analyzeFlow(
  flow: string,
  payloadSize: PayloadSizeLabel,
  fn: (trace: MethodTrace[]) => Promise<void>,
): Promise<FlowAnalysis> {
  const traces: MethodTrace[] = [];
  const started = performance.now();
  await fn(traces);
  const normalizedTraces = traces.map((trace) => ({ ...trace, flow, payloadSize }));
  const totalMs = roundMs(performance.now() - started);
  const measuredMs = roundMs(normalizedTraces
    .filter((trace) => trace.phase === 'measured')
    .reduce((sum, trace) => sum + trace.durationMs, 0));
  return { flow, payloadSize, totalMs, measuredMs, traces: normalizedTraces };
}

async function traceSharedMemoryWrite(
  traces: MethodTrace[],
  client: LayeredDkgBenchmarkClient,
  config: BenchmarkConfig,
  payload: BenchmarkPayload,
) {
  return traceAsync(traces, 'setup', 'sharedMemoryWrite', ['writeWorkingMemory', 'liftWorkingMemoryToSharedMemory'], 'Stage generated quads in local memory and lift them into shared working memory.', () => (
    client.sharedMemoryWrite(config.contextGraphId, payload.quads)
  ), payloadContext(payload));
}

async function traceAsync<T>(
  traces: MethodTrace[],
  phase: TracePhase,
  method: string,
  invokes: string[],
  detail: string,
  fn: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<T> {
  const started = performance.now();
  try {
    const value = await fn();
    traces.push({ flow: '', payloadSize: '10kb', phase, method, invokes, detail, durationMs: roundMs(performance.now() - started), success: true, context });
    return value;
  } catch (error) {
    traces.push({ flow: '', payloadSize: '10kb', phase, method, invokes, detail, durationMs: roundMs(performance.now() - started), success: false, context, error: errorMessage(error) });
    throw error;
  }
}

function traceSync<T>(
  traces: MethodTrace[],
  phase: TracePhase,
  method: string,
  invokes: string[],
  detail: string,
  fn: () => T,
  context: Record<string, unknown> = {},
): T {
  const started = performance.now();
  try {
    const value = fn();
    traces.push({ flow: '', payloadSize: '10kb', phase, method, invokes, detail, durationMs: roundMs(performance.now() - started), success: true, context: enrichContext(value, context) });
    return value;
  } catch (error) {
    traces.push({ flow: '', payloadSize: '10kb', phase, method, invokes, detail, durationMs: roundMs(performance.now() - started), success: false, context, error: errorMessage(error) });
    throw error;
  }
}

function renderFlowSection(flow: FlowAnalysis): string {
  const rows = flow.traces.map((trace) => renderTraceRow(trace, flow.totalMs)).join('\n');
  return `<section class="flow">
    <h3>${escapeHtml(flow.flow)}</h3>
    <div class="flow-summary">
      <span>Total traced wall time: <strong>${flow.totalMs.toFixed(3)} ms</strong></span>
      <span>Measured benchmark phase: <strong>${flow.measuredMs.toFixed(3)} ms</strong></span>
      <span>Trace rows: <strong>${flow.traces.length}</strong></span>
    </div>
    <table>
      <thead>
        <tr>
          <th>Phase</th>
          <th>Method</th>
          <th>Invokes</th>
          <th>Duration</th>
          <th>Share</th>
          <th>Why it is here</th>
          <th>Context</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderTraceRow(trace: MethodTrace, totalMs: number): string {
  const share = totalMs > 0 ? Math.min(100, (trace.durationMs / totalMs) * 100) : 0;
  return `<tr>
    <td><span class="phase ${trace.phase}">${escapeHtml(trace.phase)}</span></td>
    <td><code>${escapeHtml(trace.method)}</code>${trace.success ? '' : `<div>${escapeHtml(trace.error ?? 'failed')}</div>`}</td>
    <td>${trace.invokes.length ? trace.invokes.map((name) => `<code>${escapeHtml(name)}</code>`).join(' -> ') : ''}</td>
    <td>${trace.durationMs.toFixed(3)} ms</td>
    <td><div class="bar" title="${share.toFixed(2)}%"><span style="width: ${share.toFixed(2)}%"></span></div></td>
    <td>${escapeHtml(trace.detail)}</td>
    <td class="context">${escapeHtml(JSON.stringify(trace.context))}</td>
  </tr>`;
}

function createConfig(payloadSize: PayloadSizeLabel): BenchmarkConfig {
  return {
    contextGraphId: 'bench-cg',
    repeat: 1,
    warmups: 0,
    timeoutMs: 120_000,
    payloadSizeBytes: payloadSizeBytes(payloadSize),
    fixture: 'generated',
    outputFormat: 'json',
    namespace: 'benchmark',
    scope: 'publish-async-get',
    authorityProofRef: 'proof:benchmark-local',
    pollIntervalMs: 1000,
    asyncSuccessStatuses: ['finalized'],
    getView: 'verified-memory',
  };
}

function resolvePayloadSizeLabels(): PayloadSizeLabel[] {
  const raw = process.env.DKG_ESBENCH_PAYLOAD_SIZES;
  if (!raw?.trim()) return GENERATED_PAYLOAD_SIZES.map((size) => size.label);
  const requested = raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0) return GENERATED_PAYLOAD_SIZES.map((size) => size.label);

  const known = new Set(GENERATED_PAYLOAD_SIZES.map((size) => size.label));
  for (const label of requested) {
    if (!known.has(label as PayloadSizeLabel)) {
      throw new Error(`Unknown DKG_ESBENCH_PAYLOAD_SIZES entry "${label}". Expected one of: ${[...known].join(', ')}`);
    }
  }
  return requested as PayloadSizeLabel[];
}

function payloadSizeBytes(label: PayloadSizeLabel): number {
  const size = GENERATED_PAYLOAD_SIZES.find((entry) => entry.label === label);
  if (!size) throw new Error(`Unknown payload size label: ${label}`);
  return size.bytes;
}

function payloadContext(payload: BenchmarkPayload): Record<string, unknown> {
  return {
    rootEntity: payload.rootEntity,
    marker: payload.marker,
    quadCount: payload.quads.length,
  };
}

function enrichContext(value: unknown, context: Record<string, unknown>): Record<string, unknown> {
  if (isPayload(value)) return { ...context, ...payloadContext(value) };
  return context;
}

function isPayload(value: unknown): value is BenchmarkPayload {
  return Boolean(value && typeof value === 'object' && 'rootEntity' in value && 'marker' in value && 'quads' in value);
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativePath(file: string): string {
  return file.startsWith(process.cwd()) ? file.slice(process.cwd().length + 1) : file;
}

async function linkExistingBenchmarkReports(): Promise<void> {
  const reportFiles = [
    'bench/results/latest.html',
    ...PUBLISH_ASYNC_GET_PAGES.map(([, file]) => file),
  ];
  const targets: Array<[string, string]> = [
    ['Combined report', 'bench/results/latest.html'],
    ...PUBLISH_ASYNC_GET_PAGES,
  ];

  if (existsSync(resolve(process.cwd(), 'bench/results/profiles/index.html'))) {
    targets.push(['CPU profiles', 'bench/results/profiles/index.html']);
  }
  targets.push(['Method analysis', 'bench/results/profiles/method-analysis.latest.html']);

  for (const file of reportFiles) {
    const reportPath = resolve(process.cwd(), file);
    if (!existsSync(reportPath)) continue;
    const html = await readFile(reportPath, 'utf8');
    await writeFile(reportPath, addLinkedReportNavigation(html, file, targets), 'utf8');
  }
}

function addLinkedReportNavigation(html: string, currentFile: string, targets: Array<[string, string]>): string {
  const start = '<!-- dkg-benchmark-report-nav:start -->';
  const end = '<!-- dkg-benchmark-report-nav:end -->';
  const withoutExisting = html.replace(new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'g'), '');
  const links = targets.map(([label, targetFile]) => {
    const active = currentFile === targetFile ? ' aria-current="page"' : '';
    return `<a class="dkg-benchmark-report-nav__link" href="${escapeHtml(relativeReportHref(currentFile, targetFile))}"${active}>${escapeHtml(label)}</a>`;
  }).join('');
  const navHtml = `<nav id="dkg-benchmark-report-nav" class="dkg-benchmark-report-nav" aria-label="DKG benchmark reports"><span class="dkg-benchmark-report-nav__title">DKG benchmark reports</span>${links}</nav>`;
  const block = `${start}
<style>
  body.dkg-benchmark-report-linked { padding-top: 48px; }
  .dkg-benchmark-report-nav { align-items: center; background: #111827; border-bottom: 1px solid #374151; box-shadow: 0 1px 8px rgba(0, 0, 0, .16); color: #f9fafb; display: flex; font: 13px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; gap: 8px; left: 0; min-height: 48px; overflow-x: auto; padding: 8px 14px; position: fixed; right: 0; top: 0; z-index: 2147483647; }
  .dkg-benchmark-report-nav__title { color: #d1d5db; flex: 0 0 auto; font-weight: 700; margin-right: 4px; }
  .dkg-benchmark-report-nav__link { border: 1px solid #4b5563; border-radius: 4px; color: #f9fafb; flex: 0 0 auto; padding: 4px 8px; text-decoration: none; white-space: nowrap; }
  .dkg-benchmark-report-nav__link:hover, .dkg-benchmark-report-nav__link:focus { background: #1f2937; }
  .dkg-benchmark-report-nav__link[aria-current="page"] { background: #2563eb; border-color: #60a5fa; }
</style>
<script>
  window.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("dkg-benchmark-report-nav")) return;
    document.body.classList.add("dkg-benchmark-report-linked");
    document.body.insertAdjacentHTML("afterbegin", ${JSON.stringify(navHtml)});
  });
</script>
${end}
`;

  return withoutExisting.includes('</head>')
    ? withoutExisting.replace('</head>', `${block}</head>`)
    : `${block}${withoutExisting}`;
}

function relativeReportHref(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split('/');
  fromParts.pop();
  const toParts = toFile.split('/');
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return [...fromParts.map(() => '..'), ...toParts].join('/') || (toFile.split('/').at(-1) ?? toFile);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
