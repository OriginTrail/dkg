import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerViewSemanticsCommand } from '../src/commands/view-semantics.js';
import { handleViewSemanticsRoutes, VIEW_SEMANTICS_DELTA_PATH } from '../src/daemon/routes/view-semantics.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { createViewSemanticsClient } from '../src/view-semantics-client.js';
import {
  formatViewSemanticsDeltaReport, type ViewSemanticsDeltaReportEntry, type ViewSemanticsDeltaReportResponse,
} from '../src/view-semantics-report.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const ENTRY: ViewSemanticsDeltaReportEntry = {
  contextGraphId: 'cg-products', since: '2026-11-11T02:00:00.000Z', samples: 40, skipped: 2, uncomparable: 0,
  kinds: { 'none': 30, 'copies-removed': 4, 'rows-added': 5, 'rows-removed-or-changed': 1 },
  shapes: [
    { shape: 'SELECT ?p ?x WHERE { ?p a <…> . ?p <…> ?x }', view: 'verifiable-memory', samples: 8, lastSampledAt: '2026-11-11T02:30:00.000Z',
      kinds: { 'none': 3, 'copies-removed': 0, 'rows-added': 5, 'rows-removed-or-changed': 0 } },
    { shape: 'SELECT ?s WHERE { ?s ?p ?o }', view: 'verifiable-memory', samples: 30, lastSampledAt: '2026-11-11T02:31:00.000Z',
      kinds: { 'none': 26, 'copies-removed': 4, 'rows-added': 0, 'rows-removed-or-changed': 0 } },
  ],
};

class ResponseStub {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; }
}

function route(kind: 'nodeOperator' | 'agent', search = '') {
  const res = new ResponseStub();
  const viewSemanticsDeltaReport = vi.fn(() => [ENTRY, { ...ENTRY, contextGraphId: 'cg-hidden' }]);
  const canReadContextGraph = vi.fn(async (contextGraphId: string) => contextGraphId === ENTRY.contextGraphId);
  const ctx = {
    req: { method: 'GET' }, res, path: VIEW_SEMANTICS_DELTA_PATH,
    url: new URL(`http://127.0.0.1${VIEW_SEMANTICS_DELTA_PATH}${search}`),
    agent: { queryEngine: { viewSemanticsDeltaReport }, canReadContextGraph },
    authentication: kind === 'agent'
      ? requestAuthentication({ kind: 'agent', agentAddress: '0x1111111111111111111111111111111111111111' })
      : requestAuthentication({ kind: 'nodeOperator' }),
  } as unknown as RequestContext;
  return { ctx, res, viewSemanticsDeltaReport, canReadContextGraph };
}

describe('GET /api/query/view-semantics-delta', () => {
  it('answers a node admin with the summaries of the context graphs it may read', async () => {
    const { ctx, res, viewSemanticsDeltaReport, canReadContextGraph } = route('nodeOperator', '?contextGraphId=cg-products');
    await handleViewSemanticsRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ contextGraphs: [ENTRY] });
    expect(viewSemanticsDeltaReport).toHaveBeenCalledWith(['cg-products']);
    expect(canReadContextGraph).toHaveBeenCalledWith('cg-hidden', { callerAgentAddress: undefined });
  });

  it('refuses a caller without a node-level admin token', async () => {
    const { ctx, res, viewSemanticsDeltaReport } = route('agent');
    await handleViewSemanticsRoutes(ctx);
    expect(res.statusCode).toBe(403);
    expect(viewSemanticsDeltaReport).not.toHaveBeenCalled();
  });

  it('leaves other routes alone', async () => {
    const { ctx, res } = route('nodeOperator');
    await handleViewSemanticsRoutes({ ...ctx, path: '/api/query' } as RequestContext);
    expect(res.writableEnded).toBe(false);
  });
});

describe('the CLI client of the report', () => {
  it('asks for one context graph or all', async () => {
    const get = vi.fn(async () => ({ contextGraphs: [] }));
    const client = createViewSemanticsClient(get as never);
    await client.deltaReport('did:dkg:context-graph:a/b');
    await client.deltaReport();
    expect(get.mock.calls).toEqual([
      ['/api/query/view-semantics-delta?contextGraphId=did%3Adkg%3Acontext-graph%3Aa%2Fb'],
      ['/api/query/view-semantics-delta'],
    ]);
  });
});

describe('the printed report', () => {
  it('shows each kind with its share, the verdict, and the shapes whose rows would change', () => {
    const text = formatViewSemanticsDeltaReport({ contextGraphs: [ENTRY] });
    expect(text.split('\n')).toEqual([
      'How sampled view queries would answer with semantics "merged" instead of "per-asset":',
      '',
      'cg-products: 40 sampled since 2026-11-11 02:00 UTC, 2 skipped (the read graph changed, or a read failed)',
      '  same answer                         30   75.0%',
      '  only duplicate copies removed        4   10.0%',
      '  rows added                           5   12.5%',
      '  rows removed or changed              1    2.5%',
      '  6 of 40 sampled queries (15.0%) would get other rows.',
      '  Query shapes whose rows would change, most first:',
      '    5 of 8 samples (rows added 5), verifiable-memory:',
      '      SELECT ?p ?x WHERE { ?p a <…> . ?p <…> ?x }',
    ]);
  });

  it('says when every sample gets the same rows, and when nothing was sampled', () => {
    const same = { ...ENTRY, skipped: 0, kinds: { 'none': 36, 'copies-removed': 4, 'rows-added': 0, 'rows-removed-or-changed': 0 }, shapes: [] };
    expect(formatViewSemanticsDeltaReport({ contextGraphs: [same] }))
      .toContain('Every sampled query gets the same rows merged, at most without duplicate copies.');
    expect(formatViewSemanticsDeltaReport({ contextGraphs: [] })).toMatch(/^No view queries have been sampled yet\./);
  });

  it('says when no sampled query could be compared, and how many were not', () => {
    const none = { ...ENTRY, samples: 0, skipped: 1, uncomparable: 3, kinds: { 'none': 0, 'copies-removed': 0, 'rows-added': 0, 'rows-removed-or-changed': 0 }, shapes: [] };
    expect(formatViewSemanticsDeltaReport({ contextGraphs: [none] }).split('\n').slice(2)).toEqual([
      'cg-products: 0 sampled since 2026-11-11 02:00 UTC, 1 skipped (the read graph changed, or a read failed), '
        + '3 not compared (values generated during evaluation, or blank nodes their structure cannot tell apart)',
      '  No sampled query has been compared yet.',
    ]);
  });
});

describe('dkg view-semantics report', () => {
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  async function report(outcome: ViewSemanticsDeltaReportResponse | Error, ...args: string[]) {
    const deltaReport = vi.fn(async (_contextGraphId?: string) => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ viewSemantics: { deltaReport } } as unknown as ApiClient);
    const program = new Command();
    program.exitOverride();
    registerViewSemanticsCommand(program);
    await program.parseAsync(['node', 'dkg', 'view-semantics', 'report', ...args]);
    return deltaReport;
  }
  const printed = () => vi.mocked(console.log).mock.lastCall?.[0];

  it('prints the report of one context graph, or of all as JSON', async () => {
    expect(await report({ contextGraphs: [ENTRY] }, '--context-graph', 'cg-products')).toHaveBeenCalledWith('cg-products');
    expect(printed()).toBe(formatViewSemanticsDeltaReport({ contextGraphs: [ENTRY] }));
    expect(await report({ contextGraphs: [ENTRY] }, '--json')).toHaveBeenCalledWith(undefined);
    expect(JSON.parse(String(printed()))).toEqual({ contextGraphs: [ENTRY] });
    expect(process.exitCode).toBeUndefined();
  });

  it('prints why the node refused, and exits with 1', async () => {
    await report(new Error('requires a node-level admin token'));
    expect(console.error).toHaveBeenCalledWith('requires a node-level admin token');
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
