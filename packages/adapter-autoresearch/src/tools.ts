import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NS, RDF_TYPE, XSD, Class, Prop, Status, DEFAULT_PARANET } from './ontology.js';
import type { DkgClientLike, ExperimentRecord } from './types.js';

type Bindings = Array<Record<string, string>>;

function parseBindings(raw: unknown): Bindings {
  const obj = raw as { bindings?: Bindings };
  return obj?.bindings ?? [];
}

function stripType(v: string): string {
  const m = v.match(/^"(.+?)"\^\^<.+>$/);
  if (m) return m[1];
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function fmtError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toTable(bindings: Bindings, columns?: string[]): string {
  if (bindings.length === 0) return '(no results)';
  const cols = columns ?? Object.keys(bindings[0]);
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = bindings.map(row =>
    '| ' + cols.map(c => stripType(row[c] ?? '')).join(' | ') + ' |',
  );
  return [header, sep, ...rows].join('\n');
}

/**
 * Register autoresearch tools on an MCP server.
 *
 * This is the sole integration point — call it from the MCP server's
 * startup to mount autoresearch-specific tools alongside the core tools.
 */
export function registerTools(
  server: McpServer,
  getClient: () => Promise<DkgClientLike>,
  paranetId: string = DEFAULT_PARANET,
) {
  async function sparql(query: string): Promise<Bindings> {
    const client = await getClient();
    const result = await client.query(query, paranetId);
    return parseBindings(result.result);
  }

  // -----------------------------------------------------------------------
  // autoresearch_setup — One-time paranet + subscription setup
  // -----------------------------------------------------------------------
  server.registerTool(
    'autoresearch_setup',
    {
      title: 'Autoresearch: Setup Paranet',
      description:
        'Create (or join) the autoresearch paranet on this DKG node. ' +
        'Run once before publishing experiments. Idempotent.',
      inputSchema: {},
    },
    async () => {
      try {
        const client = await getClient();
        try {
          await client.createParanet(
            paranetId,
            'Autoresearch',
            'Collaborative autonomous ML research — experiment results shared as Knowledge Assets',
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!(/already exists/i.test(msg) || /duplicate/i.test(msg))) throw e;
        }
        await client.subscribe(paranetId);
        return ok(`Paranet "${paranetId}" ready. This node is subscribed.`);
      } catch (e) { return err(`Setup failed: ${fmtError(e)}`); }
    },
  );

  // -----------------------------------------------------------------------
  // autoresearch_publish_experiment — Publish a single experiment result
  // -----------------------------------------------------------------------
  server.registerTool(
    'autoresearch_publish_experiment',
    {
      title: 'Autoresearch: Publish Experiment',
      description:
        'Publish the results of a single autoresearch training run to the DKG. ' +
        'The experiment becomes a Knowledge Asset queryable by all agents on the paranet.',
      inputSchema: {
        val_bpb: z.number().describe('Validation bits-per-byte (lower is better)'),
        peak_vram_mb: z.number().describe('Peak VRAM in MB (0 for crashes)'),
        status: z.enum(['keep', 'discard', 'crash']).describe('Outcome: keep, discard, or crash'),
        description: z.string().describe('Short description of what this experiment tried'),
        commit_hash: z.string().optional().describe('Git commit hash (7 char short hash)'),
        code_diff: z.string().optional().describe('Unified diff of changes to train.py'),
        training_seconds: z.number().optional().describe('Wall-clock training time in seconds'),
        total_tokens_m: z.number().optional().describe('Total tokens processed in millions'),
        num_params_m: z.number().optional().describe('Model parameter count in millions'),
        mfu_percent: z.number().optional().describe('Model FLOPs utilization percentage'),
        depth: z.number().int().nonnegative().optional().describe('Number of transformer layers'),
        num_steps: z.number().int().nonnegative().optional().describe('Number of training steps'),
        platform: z.string().optional().describe('Hardware platform (e.g. H100, A100, M4-Max)'),
        agent_did: z.string().optional().describe('DID of the agent that ran this experiment'),
        run_tag: z.string().optional().describe('Run tag (e.g. mar8, mar8-gpu0)'),
        parent_experiment: z.string().optional().describe('URI of the parent experiment this builds on'),
      },
    },
    async (params) => {
      try {
        const client = await getClient();
        const ts = new Date().toISOString();
        const id = `urn:autoresearch:exp:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const graph = `urn:paranet:${paranetId}`;

        const statusUri = params.status === 'keep' ? Status.Keep
          : params.status === 'discard' ? Status.Discard
          : Status.Crash;

        const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [
          { subject: id, predicate: RDF_TYPE, object: Class.Experiment, graph },
          { subject: id, predicate: Prop.valBpb, object: `"${params.val_bpb}"^^<${XSD}double>`, graph },
          { subject: id, predicate: Prop.peakVramMb, object: `"${params.peak_vram_mb}"^^<${XSD}double>`, graph },
          { subject: id, predicate: Prop.status, object: statusUri, graph },
          { subject: id, predicate: Prop.description, object: `"${esc(params.description)}"`, graph },
          { subject: id, predicate: Prop.timestamp, object: `"${ts}"^^<${XSD}dateTime>`, graph },
        ];

        if (params.commit_hash) quads.push({ subject: id, predicate: Prop.commitHash, object: `"${esc(params.commit_hash)}"`, graph });
        if (params.code_diff) quads.push({ subject: id, predicate: Prop.codeDiff, object: `"${esc(params.code_diff)}"`, graph });
        if (params.training_seconds != null) quads.push({ subject: id, predicate: Prop.trainingSeconds, object: `"${params.training_seconds}"^^<${XSD}double>`, graph });
        if (params.total_tokens_m != null) quads.push({ subject: id, predicate: Prop.totalTokensM, object: `"${params.total_tokens_m}"^^<${XSD}double>`, graph });
        if (params.num_params_m != null) quads.push({ subject: id, predicate: Prop.numParamsM, object: `"${params.num_params_m}"^^<${XSD}double>`, graph });
        if (params.mfu_percent != null) quads.push({ subject: id, predicate: Prop.mfuPercent, object: `"${params.mfu_percent}"^^<${XSD}double>`, graph });
        if (params.depth != null) quads.push({ subject: id, predicate: Prop.depth, object: `"${params.depth}"^^<${XSD}integer>`, graph });
        if (params.num_steps != null) quads.push({ subject: id, predicate: Prop.numSteps, object: `"${params.num_steps}"^^<${XSD}integer>`, graph });
        if (params.platform) quads.push({ subject: id, predicate: Prop.platform, object: `"${esc(params.platform)}"`, graph });
        if (params.agent_did) quads.push({ subject: id, predicate: Prop.agentDid, object: `"${esc(params.agent_did)}"`, graph });
        if (params.run_tag) quads.push({ subject: id, predicate: Prop.runTag, object: `"${esc(params.run_tag)}"`, graph });
        if (params.parent_experiment) quads.push({ subject: id, predicate: Prop.parentExperiment, object: params.parent_experiment, graph });

        const result = await client.publish(paranetId, quads);
        return ok(
          `Published experiment as Knowledge Asset.\n` +
          `  URI: ${id}\n` +
          `  KC:  ${result.kcId}\n` +
          `  val_bpb: ${params.val_bpb} | status: ${params.status}\n` +
          `  description: ${params.description}`,
        );
      } catch (e) { return err(`Publish failed: ${fmtError(e)}`); }
    },
  );

  // -----------------------------------------------------------------------
  // autoresearch_best_results — Query the best experiments across all agents
  // -----------------------------------------------------------------------
  server.registerTool(
    'autoresearch_best_results',
    {
      title: 'Autoresearch: Best Results',
      description:
        'Query the DKG for the best (lowest val_bpb) experiments across all agents ' +
        'on the autoresearch paranet. Use this before starting a new experiment to ' +
        'learn from the collective findings.',
      inputSchema: {
        limit: z.number().int().min(1).optional().default(20).describe('Max results to return (default 20)'),
        platform: z.string().optional().describe('Filter by platform (e.g. H100)'),
        status: z.enum(['keep', 'discard', 'crash']).optional().describe('Filter by status'),
      },
    },
    async ({ limit, platform, status }) => {
      try {
        const AR = NS;
        const filters: string[] = [];
        if (platform) filters.push(`FILTER(CONTAINS(LCASE(?platform), LCASE("${esc(platform)}")))`);
        if (status) {
          const statusUri = status === 'keep' ? Status.Keep : status === 'discard' ? Status.Discard : Status.Crash;
          filters.push(`FILTER(?status = <${statusUri}>)`);
        }

        const q = `
          SELECT ?exp ?valBpb ?peakVram ?status ?desc ?platform ?agent ?runTag ?ts ?depth ?params WHERE {
            ?exp a <${Class.Experiment}> ;
                 <${Prop.valBpb}> ?valBpb ;
                 <${Prop.peakVramMb}> ?peakVram ;
                 <${Prop.status}> ?status ;
                 <${Prop.description}> ?desc ;
                 <${Prop.timestamp}> ?ts .
            OPTIONAL { ?exp <${Prop.platform}> ?platform }
            OPTIONAL { ?exp <${Prop.agentDid}> ?agent }
            OPTIONAL { ?exp <${Prop.runTag}> ?runTag }
            OPTIONAL { ?exp <${Prop.depth}> ?depth }
            OPTIONAL { ?exp <${Prop.numParamsM}> ?params }
            ${filters.join('\n            ')}
          }
          ORDER BY ASC(?valBpb)
          LIMIT ${limit ?? 20}`;

        const rows = await sparql(q);
        if (rows.length === 0) return ok('No experiments found on the autoresearch paranet yet.');

        const summary = rows.map((r, i) => {
          const parts = [
            `${i + 1}. val_bpb: ${stripType(r.valBpb)}`,
            `status: ${stripType(r.status).replace(NS, '')}`,
            `desc: ${stripType(r.desc)}`,
          ];
          if (r.platform) parts.push(`platform: ${stripType(r.platform)}`);
          if (r.agent) parts.push(`agent: ${stripType(r.agent)}`);
          if (r.depth) parts.push(`depth: ${stripType(r.depth)}`);
          if (r.params) parts.push(`params_M: ${stripType(r.params)}`);
          return parts.join(' | ');
        }).join('\n');

        return ok(`Top ${rows.length} experiments (lowest val_bpb):\n\n${summary}`);
      } catch (e) { return err(`Query failed: ${fmtError(e)}`); }
    },
  );

  // -----------------------------------------------------------------------
  // autoresearch_experiment_history — Full history for a run tag or agent
  // -----------------------------------------------------------------------
  server.registerTool(
    'autoresearch_experiment_history',
    {
      title: 'Autoresearch: Experiment History',
      description:
        'Query the full experiment history for a specific run tag or agent. ' +
        'Shows the progression of experiments over time, useful for understanding ' +
        'what was tried and what worked.',
      inputSchema: {
        run_tag: z.string().optional().describe('Filter by run tag (e.g. mar8)'),
        agent_did: z.string().optional().describe('Filter by agent DID'),
        limit: z.number().int().min(1).optional().default(50).describe('Max results (default 50)'),
      },
    },
    async ({ run_tag, agent_did, limit }) => {
      try {
        const filters: string[] = [];
        if (run_tag) filters.push(`?exp <${Prop.runTag}> "${esc(run_tag)}" .`);
        if (agent_did) filters.push(`?exp <${Prop.agentDid}> "${esc(agent_did)}" .`);

        const q = `
          SELECT ?exp ?valBpb ?peakVram ?status ?desc ?ts ?commitHash WHERE {
            ?exp a <${Class.Experiment}> ;
                 <${Prop.valBpb}> ?valBpb ;
                 <${Prop.peakVramMb}> ?peakVram ;
                 <${Prop.status}> ?status ;
                 <${Prop.description}> ?desc ;
                 <${Prop.timestamp}> ?ts .
            ${filters.join('\n            ')}
            OPTIONAL { ?exp <${Prop.commitHash}> ?commitHash }
          }
          ORDER BY ASC(?ts)
          LIMIT ${limit ?? 50}`;

        const rows = await sparql(q);
        if (rows.length === 0) return ok('No experiments found matching the filter.');

        return ok(`Experiment history (${rows.length} results):\n\n${toTable(rows, ['ts', 'valBpb', 'status', 'desc', 'commitHash'])}`);
      } catch (e) { return err(`Query failed: ${fmtError(e)}`); }
    },
  );

  // -----------------------------------------------------------------------
  // autoresearch_insights — Summarize findings for a research direction
  // -----------------------------------------------------------------------
  server.registerTool(
    'autoresearch_insights',
    {
      title: 'Autoresearch: Research Insights',
      description:
        'Query the DKG for experiment descriptions matching a keyword to find ' +
        'what other agents have tried in a specific research direction. ' +
        'Use this to avoid re-running failed experiments and to find promising leads.',
      inputSchema: {
        keyword: z.string().describe('Keyword to search in experiment descriptions (e.g. "learning rate", "GeLU", "depth")'),
        limit: z.number().int().min(1).optional().default(20).describe('Max results (default 20)'),
      },
    },
    async ({ keyword, limit }) => {
      try {
        const q = `
          SELECT ?exp ?valBpb ?status ?desc ?platform ?agent WHERE {
            ?exp a <${Class.Experiment}> ;
                 <${Prop.valBpb}> ?valBpb ;
                 <${Prop.status}> ?status ;
                 <${Prop.description}> ?desc .
            OPTIONAL { ?exp <${Prop.platform}> ?platform }
            OPTIONAL { ?exp <${Prop.agentDid}> ?agent }
            FILTER(CONTAINS(LCASE(?desc), LCASE("${esc(keyword)}")))
          }
          ORDER BY ASC(?valBpb)
          LIMIT ${limit ?? 20}`;

        const rows = await sparql(q);
        if (rows.length === 0) return ok(`No experiments found matching "${keyword}".`);

        const kept = rows.filter(r => stripType(r.status).includes('keep')).length;
        const discarded = rows.filter(r => stripType(r.status).includes('discard')).length;
        const crashed = rows.filter(r => stripType(r.status).includes('crash')).length;

        const summary = `Found ${rows.length} experiments matching "${keyword}" ` +
          `(${kept} kept, ${discarded} discarded, ${crashed} crashed):\n\n` +
          toTable(rows, ['valBpb', 'status', 'desc', 'platform']);

        return ok(summary);
      } catch (e) { return err(`Query failed: ${fmtError(e)}`); }
    },
  );

  // -----------------------------------------------------------------------
  // autoresearch_query — Raw SPARQL fallback for the autoresearch paranet
  // -----------------------------------------------------------------------
  server.registerTool(
    'autoresearch_query',
    {
      title: 'Autoresearch: SPARQL Query',
      description:
        'Execute a raw SPARQL query against the autoresearch paranet. ' +
        'Use when the other autoresearch tools cannot express your query. ' +
        `Namespace: autoresearch = <${NS}>. ` +
        'Types: Experiment, AgentRun. ' +
        'Key properties: valBpb, peakVramMb, status, description, commitHash, ' +
        'codeDiff, platform, agentDid, runTag, timestamp, parentExperiment, ' +
        'trainingSeconds, totalTokensM, numParamsM, mfuPercent, depth, numSteps.',
      inputSchema: {
        sparql: z.string().describe('SPARQL SELECT query'),
      },
    },
    async ({ sparql: query }) => {
      try {
        const rows = await sparql(query);
        return ok(toTable(rows));
      } catch (e) { return err(`Query error: ${fmtError(e)}`); }
    },
  );
}
