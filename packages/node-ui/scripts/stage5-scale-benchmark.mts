import { performance } from 'node:perf_hooks';
import { ChatMemoryManager } from '../src/chat-memory.ts';
import { OxigraphStore } from '../../storage/src/adapters/oxigraph.ts';

type Quad = {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
};

type SessionBenchResult = {
  sessions: number;
  messagesPerSession: number;
  medianMs: number;
  p95Ms: number;
  queryCallsPerRun: number;
  returnedSessions: number;
};

type GraphBenchResult = {
  targetTriples: number;
  seededTriples: number;
  medianMs: number;
  p95Ms: number;
  mergedQuads: number;
};

const MEMORY_PARANET = 'agent-memory';
const DATA_GRAPH = `did:dkg:paranet:${MEMORY_PARANET}`;
const WORKSPACE_GRAPH = `${DATA_GRAPH}/_workspace`;
const CHAT_NS = 'urn:dkg:chat:';
const SCHEMA = 'http://schema.org/';
const DKG = 'http://dkg.io/ontology/';

const SESSION_SIZES = [10, 100, 1000];
const GRAPH_SIZES = [1000, 5000, 20000];

const MESSAGES_PER_SESSION = 6;
const SESSION_RUNS = 8;
const SESSION_WARMUP = 2;
const GRAPH_RUNS = 7;
const GRAPH_WARMUP = 2;

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function quantileInt(values: number[], q: number): number {
  return Math.round(quantile(values, q));
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function wrapWithGraph(sparql: string, graphUri: string): string {
  const whereIdx = sparql.search(/WHERE\s*\{/i);
  if (whereIdx === -1) return sparql;
  const braceStart = sparql.indexOf('{', whereIdx);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < sparql.length; i += 1) {
    if (sparql[i] === '{') depth += 1;
    else if (sparql[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) return sparql;
  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);
  return `${before} GRAPH <${graphUri}> { ${inner} } ${after}`;
}

function dedupeQuads(quads: Array<{ subject: string; predicate: string; object: string; graph: string }>) {
  const seen = new Set<string>();
  const out: typeof quads = [];
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}\u0000${q.graph}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function makeSessionBindings(sessionCount: number) {
  return Array.from({ length: sessionCount }, (_, i) => ({
    s: `${CHAT_NS}session:bench-${i}`,
    sid: `"bench-${i}"`,
  }));
}

function makeMessageBindings(sessionCount: number, messagesPerSession: number) {
  const rows: Array<Record<string, string>> = [];
  for (let s = 0; s < sessionCount; s += 1) {
    const sessionUri = `${CHAT_NS}session:bench-${s}`;
    for (let m = 0; m < messagesPerSession; m += 1) {
      const isUser = m % 2 === 0;
      rows.push({
        session: sessionUri,
        author: isUser ? `${CHAT_NS}actor:user` : `${CHAT_NS}actor:agent`,
        text: `"message-${s}-${m}"`,
        ts: `"2026-03-08T12:${String(s % 60).padStart(2, '0')}:${String(m).padStart(2, '0')}Z"`,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.session === b.session) return a.ts.localeCompare(b.ts);
    return a.session.localeCompare(b.session);
  });
  return rows;
}

async function benchmarkSessionList(sessionCount: number): Promise<SessionBenchResult> {
  const sessions = makeSessionBindings(sessionCount);
  const messages = makeMessageBindings(sessionCount, MESSAGES_PER_SESSION);
  let queryCalls = 0;

  const manager = new ChatMemoryManager(
    {
      query: async (sparql: string) => {
        queryCalls += 1;
        if (sparql.includes('SELECT ?sid WHERE')) return { bindings: [] };
        if (sparql.includes('GROUP BY ?s ?sid')) return { bindings: sessions };
        if (sparql.includes('VALUES ?session')) return { bindings: messages };
        return { bindings: [] };
      },
      writeToWorkspace: async () => ({}),
      enshrineFromWorkspace: async () => ({}),
      createParanet: async () => undefined,
      listParanets: async () => [{ id: MEMORY_PARANET, name: 'Agent Memory' }],
    },
    { apiKey: '' },
  );

  const samples: number[] = [];
  let returnedSessions = 0;
  const runCallSamples: number[] = [];

  for (let i = 0; i < SESSION_RUNS; i += 1) {
    const beforeCalls = queryCalls;
    const start = performance.now();
    const chats = await manager.getRecentChats(sessionCount);
    const elapsed = performance.now() - start;
    const callsThisRun = queryCalls - beforeCalls;
    if (i >= 1) runCallSamples.push(callsThisRun);
    returnedSessions = chats.length;
    if (i >= SESSION_WARMUP) samples.push(elapsed);
  }

  return {
    sessions: sessionCount,
    messagesPerSession: MESSAGES_PER_SESSION,
    medianMs: quantile(samples, 0.5),
    p95Ms: quantile(samples, 0.95),
    queryCallsPerRun: quantileInt(runCallSamples, 0.5),
    returnedSessions,
  };
}

function makeGraphQuads(targetTriples: number, graph: string, startIndex: number): Quad[] {
  const quads: Quad[] = [];
  const sessionUri = `${CHAT_NS}session:benchmark`;
  let i = startIndex;

  const pushQuad = (subject: string, predicate: string, object: string) => {
    if (quads.length >= targetTriples) return;
    quads.push({ subject, predicate, object, graph });
  };

  pushQuad(sessionUri, `${SCHEMA}name`, '"Benchmark Session"');
  pushQuad(sessionUri, `${DKG}sessionId`, '"benchmark"');

  while (quads.length < targetTriples) {
    const msg = `${CHAT_NS}msg:${i}`;
    const tool = `${CHAT_NS}tool:${i}`;
    const entity = `urn:dkg:entity:${i}`;
    const memory = `urn:dkg:memory:${i}`;
    const second = String(i % 60).padStart(2, '0');

    pushQuad(msg, `${SCHEMA}isPartOf`, sessionUri);
    pushQuad(msg, `${SCHEMA}text`, `"message ${i}"`);
    pushQuad(msg, `${SCHEMA}dateCreated`, `"2026-03-08T12:00:${second}Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`);
    pushQuad(msg, `${DKG}usedTool`, tool);
    pushQuad(tool, `${SCHEMA}name`, `"tool ${i}"`);
    pushQuad(entity, `${DKG}mentionedIn`, msg);
    pushQuad(entity, `${SCHEMA}name`, `"entity ${i}"`);
    pushQuad(memory, `${DKG}extractedFrom`, sessionUri);
    pushQuad(memory, `${SCHEMA}name`, `"memory ${i}"`);
    i += 1;
  }
  return quads;
}

function sessionGraphConstructQuery(limit: number): string {
  const sessionUri = `${CHAT_NS}session:benchmark`;
  return `CONSTRUCT { ?s ?p ?o } WHERE {
    {
      SELECT ?s ?p ?o WHERE {
        { <${sessionUri}> ?p ?o . BIND(<${sessionUri}> AS ?s) }
        UNION
        { ?s <http://schema.org/isPartOf> <${sessionUri}> . ?s ?p ?o }
        UNION
        { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
          ?msg <http://dkg.io/ontology/usedTool> ?tool .
          ?tool ?p ?o . BIND(?tool AS ?s) }
        UNION
        { ?msg <http://schema.org/isPartOf> <${sessionUri}> .
          ?entity <http://dkg.io/ontology/mentionedIn> ?msg .
          ?entity ?p ?o . BIND(?entity AS ?s) }
        UNION
        { ?memory <http://dkg.io/ontology/extractedFrom> <${sessionUri}> .
          ?memory ?p ?o . BIND(?memory AS ?s) }
      }
      ORDER BY ?s ?p ?o
      LIMIT ${limit}
    }
  }`;
}

async function benchmarkGraphQuery(targetTriples: number): Promise<GraphBenchResult> {
  const store = new OxigraphStore();
  const dataSize = Math.ceil(targetTriples / 2);
  const workspaceSize = Math.floor(targetTriples / 2);
  const dataQuads = makeGraphQuads(dataSize, DATA_GRAPH, 0);
  const workspaceQuads = makeGraphQuads(workspaceSize, WORKSPACE_GRAPH, 1_000_000);
  await store.insert([...dataQuads, ...workspaceQuads]);

  const query = sessionGraphConstructQuery(targetTriples + 1);
  const dataQuery = wrapWithGraph(query, DATA_GRAPH);
  const workspaceQuery = wrapWithGraph(query, WORKSPACE_GRAPH);

  const samples: number[] = [];
  let mergedCount = 0;
  for (let i = 0; i < GRAPH_RUNS; i += 1) {
    const start = performance.now();
    const data = await store.query(dataQuery);
    const workspace = await store.query(workspaceQuery);
    const merged = dedupeQuads([
      ...(data.type === 'quads' ? data.quads : []),
      ...(workspace.type === 'quads' ? workspace.quads : []),
    ]);
    const elapsed = performance.now() - start;
    mergedCount = merged.length;
    if (i >= GRAPH_WARMUP) samples.push(elapsed);
  }
  await store.close();

  return {
    targetTriples,
    seededTriples: dataQuads.length + workspaceQuads.length,
    medianMs: quantile(samples, 0.5),
    p95Ms: quantile(samples, 0.95),
    mergedQuads: mergedCount,
  };
}

async function main() {
  const sessionResults: SessionBenchResult[] = [];
  for (const size of SESSION_SIZES) {
    sessionResults.push(await benchmarkSessionList(size));
  }

  const graphResults: GraphBenchResult[] = [];
  for (const size of GRAPH_SIZES) {
    graphResults.push(await benchmarkGraphQuery(size));
  }

  console.log('Stage 5 session benchmark (getRecentChats):');
  for (const r of sessionResults) {
    console.log(
      `- sessions=${r.sessions}, msgs/session=${r.messagesPerSession}, median=${formatMs(r.medianMs)}, p95=${formatMs(r.p95Ms)}, queryCalls/run=${r.queryCallsPerRun}, returned=${r.returnedSessions}`,
    );
  }

  console.log('');
  console.log('Stage 5 graph benchmark (AgentHub session CONSTRUCT includeWorkspace):');
  for (const r of graphResults) {
    console.log(
      `- target=${r.targetTriples}, seeded=${r.seededTriples}, merged=${r.mergedQuads}, median=${formatMs(r.medianMs)}, p95=${formatMs(r.p95Ms)}`,
    );
  }

  console.log('');
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sessionResults,
        graphResults,
        notes: {
          sessionRuns: SESSION_RUNS,
          sessionWarmup: SESSION_WARMUP,
          graphRuns: GRAPH_RUNS,
          graphWarmup: GRAPH_WARMUP,
          messagesPerSession: MESSAGES_PER_SESSION,
          environment: 'local-node benchmark on current dev machine',
        },
      },
      null,
      2,
    ),
  );
}

await main();
