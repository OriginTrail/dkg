import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import { useFetch, formatTime, shortId } from '../hooks.js';
import {
  executeQuery, fetchParanets, fetchQueryHistory, fetchSavedQueries,
  createSavedQuery, deleteSavedQuery, publishTriples, sendChatMessage,
} from '../api.js';
import { RdfGraph, useRdfGraph } from '@dkg/graph-viz/react';
import type { ViewConfig } from '@dkg/graph-viz';

export function ExplorerPage() {
  return (
    <div className="page-section" style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '28px 32px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 className="serif" style={{ fontSize: 22, fontWeight: 700 }}>Memory Explorer</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Browse, query, and publish Knowledge Assets</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {[
          { to: '/explorer',          label: 'Graph',    end: true },
          { to: '/explorer/sparql',   label: 'SPARQL',   end: false },
          { to: '/explorer/paranets', label: 'Paranets', end: false },
          { to: '/explorer/publish',  label: 'Publish',  end: false },
          { to: '/explorer/history',  label: 'History',  end: false },
          { to: '/explorer/saved',    label: 'Saved',    end: false },
        ].map(t => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `mode-tab${isActive ? ' active' : ''}`
            }
            style={{ textDecoration: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'inherit' }}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      <Routes>
        <Route path="/" element={<GraphTab />} />
        <Route path="/sparql" element={<SparqlTab />} />
        <Route path="/paranets" element={<ParanetsTab />} />
        <Route path="/publish" element={<PublishTab />} />
        <Route path="/history" element={<HistoryTab />} />
        <Route path="/saved" element={<SavedTab />} />
      </Routes>
    </div>
  );
}

const GRAPH_LIMITS = [1000, 5000, 10000, 25000, 50000] as const;

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_SOFTWARE_AGENT = 'http://schema.org/SoftwareAgent';

type Triple = { subject: string; predicate: string; object: string };
type DatasetMode = 'paranet' | 'coordination';
type ThemeKey = 'dark' | 'midnight' | 'cyberpunk' | 'light' | 'aurora';
type HopFilter = 'all' | 1 | 2 | 3;
type VizProfile = 'structure' | 'flow' | 'llm';

interface ThemeSpec {
  label: string;
  palette: 'dark' | 'midnight' | 'cyberpunk' | 'light';
  edge: string;
  defaultNode: string;
  glow: string;
  typeColors: Record<string, string>;
}

function isResourceObject(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('urn:') ||
    value.startsWith('_:') ||
    (value.startsWith('<') && value.endsWith('>'))
  );
}

/**
 * Convert quads into triples so that every triple appears in the graph.
 * Literal objects become synthetic nodes (_:lit_0, _:lit_1, ...) with an
 * rdfs:label triple so the value is shown on the node.
 */
function triplesWithLiteralsAsNodes(
  quads: Array<{ subject: string; predicate: string; object: string }>,
): Array<{ subject: string; predicate: string; object: string }> {
  const out: Array<{ subject: string; predicate: string; object: string }> = [];
  let litIndex = 0;
  for (const q of quads) {
    const obj = q.object;
    if (isResourceObject(obj)) {
      out.push({ subject: q.subject, predicate: q.predicate, object: obj });
    } else {
      const litId = `_:lit_${litIndex++}`;
      out.push({ subject: q.subject, predicate: q.predicate, object: litId });
      out.push({ subject: litId, predicate: RDFS_LABEL, object: obj });
    }
  }
  return out;
}

/** Calls zoomToFit after the graph has loaded so one or few nodes are framed correctly. */
function GraphZoomToFit() {
  const { viz } = useRdfGraph();
  useEffect(() => {
    if (!viz) return;
    const t = setTimeout(() => {
      try {
        viz.zoomToFit(40);
      } catch {
        // ignore
      }
    }, 800);
    return () => clearTimeout(t);
  }, [viz]);
  return null;
}

const TYPE_FILTERS = [
  { label: 'All Types', value: '' },
  { label: 'Knowledge Assets', value: 'http://dkg.io/ontology/KnowledgeAsset' },
  { label: 'Knowledge Collections', value: 'http://dkg.io/ontology/KnowledgeCollection' },
  { label: 'Agents', value: 'https://dkg.network/ontology#Agent' },
  { label: 'Software Agents', value: 'http://schema.org/SoftwareAgent' },
  { label: 'Datasets', value: 'http://schema.org/Dataset' },
  { label: 'Coordination Runs', value: 'urn:dkg:ontology:CoordinationRun' },
  { label: 'Coordination Tasks', value: 'urn:dkg:ontology:CoordinationTask' },
];

const THEMES: Record<ThemeKey, ThemeSpec> = {
  dark: {
    label: 'Dark Indigo',
    palette: 'dark',
    edge: '#1a1a3a',
    defaultNode: '#6366f1',
    glow: 'rgba(99, 102, 241, 0.45)',
    typeColors: {
      'http://dkg.io/ontology/KnowledgeAsset': '#34d399',
      'http://dkg.io/ontology/KnowledgeCollection': '#60a5fa',
      'https://dkg.network/ontology#Agent': '#a78bfa',
      'http://schema.org/SoftwareAgent': '#a78bfa',
      'http://schema.org/Dataset': '#fbbf24',
      'urn:dkg:ontology:CoordinationRun': '#22d3ee',
      'urn:dkg:ontology:CoordinationTask': '#f472b6',
    },
  },
  midnight: {
    label: 'Midnight Blue',
    palette: 'midnight',
    edge: '#132452',
    defaultNode: '#3b82f6',
    glow: 'rgba(37, 99, 235, 0.42)',
    typeColors: {
      'http://dkg.io/ontology/KnowledgeAsset': '#38bdf8',
      'http://dkg.io/ontology/KnowledgeCollection': '#3b82f6',
      'https://dkg.network/ontology#Agent': '#818cf8',
      'http://schema.org/SoftwareAgent': '#6366f1',
      'http://schema.org/Dataset': '#f59e0b',
      'urn:dkg:ontology:CoordinationRun': '#06b6d4',
      'urn:dkg:ontology:CoordinationTask': '#fb7185',
    },
  },
  cyberpunk: {
    label: 'Cyberpunk Neon',
    palette: 'cyberpunk',
    edge: '#0d2e20',
    defaultNode: '#00ff88',
    glow: 'rgba(0, 255, 136, 0.5)',
    typeColors: {
      'http://dkg.io/ontology/KnowledgeAsset': '#39ff14',
      'http://dkg.io/ontology/KnowledgeCollection': '#00d4ff',
      'https://dkg.network/ontology#Agent': '#ff2d6a',
      'http://schema.org/SoftwareAgent': '#ff6ec7',
      'http://schema.org/Dataset': '#ffd700',
      'urn:dkg:ontology:CoordinationRun': '#06ffd0',
      'urn:dkg:ontology:CoordinationTask': '#ffaa00',
    },
  },
  light: {
    label: 'Light Studio',
    palette: 'light',
    edge: '#cbd5e1',
    defaultNode: '#4f46e5',
    glow: 'rgba(99, 102, 241, 0.25)',
    typeColors: {
      'http://dkg.io/ontology/KnowledgeAsset': '#059669',
      'http://dkg.io/ontology/KnowledgeCollection': '#2563eb',
      'https://dkg.network/ontology#Agent': '#7c3aed',
      'http://schema.org/SoftwareAgent': '#9333ea',
      'http://schema.org/Dataset': '#d97706',
      'urn:dkg:ontology:CoordinationRun': '#0891b2',
      'urn:dkg:ontology:CoordinationTask': '#db2777',
    },
  },
  aurora: {
    label: 'Aurora Gradient',
    palette: 'dark',
    edge: '#5f8598',
    defaultNode: '#22d3ee',
    glow: 'rgba(34, 211, 238, 0.5)',
    typeColors: {
      'http://dkg.io/ontology/KnowledgeAsset': '#2dd4bf',
      'http://dkg.io/ontology/KnowledgeCollection': '#22d3ee',
      'https://dkg.network/ontology#Agent': '#818cf8',
      'http://schema.org/SoftwareAgent': '#c084fc',
      'http://schema.org/Dataset': '#fbbf24',
      'urn:dkg:ontology:CoordinationRun': '#38bdf8',
      'urn:dkg:ontology:CoordinationTask': '#f472b6',
    },
  },
};

interface NodeDetails {
  uri: string;
  types: string[];
  outgoing: Array<{ predicate: string; object: string }>;
  incoming: Array<{ subject: string; predicate: string }>;
}

interface PredicateStat {
  predicate: string;
  label: string;
  count: number;
}

interface VizProfileSpec {
  label: string;
  theme: ThemeKey;
  description: string;
  edgeWidth: number;
  glowLinks: boolean;
  defaultHops: HopFilter;
}

interface LlmVizAdvice {
  predicates?: string[];
  maxHops?: HopFilter;
  note?: string;
}

const VIZ_PROFILES: Record<VizProfile, VizProfileSpec> = {
  structure: {
    label: 'V1 - Ontology Structure',
    theme: 'aurora',
    description: 'Highlights structural and type relations for architecture understanding.',
    edgeWidth: 0.9,
    glowLinks: false,
    defaultHops: 2,
  },
  flow: {
    label: 'V2 - Dependency Flow',
    theme: 'midnight',
    description: 'Emphasizes imports/calls/dependencies with animated glow traces.',
    edgeWidth: 1.1,
    glowLinks: true,
    defaultHops: 2,
  },
  llm: {
    label: 'V3 - LLM Guided Lens',
    theme: 'aurora',
    description: 'Uses ontology plus LLM recommendations for what to emphasize.',
    edgeWidth: 1.0,
    glowLinks: true,
    defaultHops: 3,
  },
};

function buildTypeMap(triples: Triple[]): Map<string, string[]> {
  const types = new Map<string, string[]>();
  for (const t of triples) {
    if (t.predicate !== RDF_TYPE) continue;
    const existing = types.get(t.subject) || [];
    existing.push(t.object);
    types.set(t.subject, existing);
  }
  return types;
}

function applyFilters(
  allTriples: Triple[],
  typeMap: Map<string, string[]>,
  typeFilter: string,
  searchQuery: string,
  selectedPredicates: Set<string>,
  maxHops: HopFilter,
  focalNodeUri: string | null,
): Triple[] {
  let filtered = allTriples;

  if (typeFilter) {
    const matchingSubjects = new Set<string>();
    for (const [subj, typeList] of typeMap) {
      if (typeList.includes(typeFilter)) matchingSubjects.add(subj);
    }
    filtered = filtered.filter((t) => matchingSubjects.has(t.subject) || matchingSubjects.has(t.object));
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const matchingNodes = new Set<string>();
    for (const t of allTriples) {
      if (t.subject.toLowerCase().includes(q) || t.object.toLowerCase().includes(q)) {
        matchingNodes.add(t.subject);
        matchingNodes.add(t.object);
      }
    }
    filtered = filtered.filter((t) => matchingNodes.has(t.subject) || matchingNodes.has(t.object));
  }

  if (selectedPredicates.size > 0) {
    filtered = filtered.filter((t) => selectedPredicates.has(t.predicate));
  }

  if (maxHops !== 'all' && focalNodeUri) {
    const adjacency = new Map<string, Set<string>>();
    for (const t of filtered) {
      if (!isResourceObject(t.object)) continue;
      if (!adjacency.has(t.subject)) adjacency.set(t.subject, new Set());
      if (!adjacency.has(t.object)) adjacency.set(t.object, new Set());
      adjacency.get(t.subject)!.add(t.object);
      adjacency.get(t.object)!.add(t.subject);
    }

    const visited = new Set<string>([focalNodeUri]);
    let frontier = new Set<string>([focalNodeUri]);
    for (let hop = 0; hop < maxHops; hop++) {
      const next = new Set<string>();
      for (const node of frontier) {
        const neighbors = adjacency.get(node);
        if (!neighbors) continue;
        for (const n of neighbors) {
          if (visited.has(n)) continue;
          visited.add(n);
          next.add(n);
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }

    filtered = filtered.filter((t) => {
      const subjectIn = visited.has(t.subject);
      if (!subjectIn) return false;
      if (!isResourceObject(t.object)) return true;
      return visited.has(t.object);
    });
  }

  return filtered;
}

function asNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    const maybeValue = (value as { value?: unknown }).value;
    return asNumeric(maybeValue);
  }
  return null;
}

function extractCountFromQueryResult(result: any): number | null {
  const rows = Array.isArray(result?.bindings) ? result.bindings : (Array.isArray(result) ? result : null);
  if (!rows || rows.length === 0) return null;
  const first = rows[0];
  if (!first || typeof first !== 'object') return null;
  for (const k of ['count', 'total', 'c']) {
    const parsed = asNumeric((first as Record<string, unknown>)[k]);
    if (parsed != null) return parsed;
  }
  for (const v of Object.values(first as Record<string, unknown>)) {
    const parsed = asNumeric(v);
    if (parsed != null) return parsed;
  }
  return null;
}

function escapeSparqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildPredicateStats(triples: Triple[], maxItems = 12): PredicateStat[] {
  const counts = new Map<string, number>();
  for (const t of triples) counts.set(t.predicate, (counts.get(t.predicate) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([predicate, count]) => ({ predicate, count, label: shortLabel(predicate) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxItems);
}

function scorePredicateForProfile(label: string, profile: VizProfile): number {
  const s = label.toLowerCase();
  const structureKeys = ['type', 'contains', 'defines', 'member', 'has', 'part', 'belongs', 'class', 'file', 'module', 'folder', 'package'];
  const flowKeys = ['call', 'import', 'depend', 'extends', 'implements', 'uses', 'invoke', 'reference', 'handoff'];
  const semanticKeys = ['agent', 'task', 'run', 'dataset', 'knowledge', 'provenance', 'trust', 'score'];
  const hit = (keys: string[]) => keys.reduce((acc, k) => acc + (s.includes(k) ? 1 : 0), 0);
  if (profile === 'structure') return hit(structureKeys) * 3 + hit(semanticKeys);
  if (profile === 'flow') return hit(flowKeys) * 3 + hit(structureKeys);
  return hit(flowKeys) * 2 + hit(structureKeys) * 2 + hit(semanticKeys);
}

function selectPredicatesForProfile(
  stats: PredicateStat[],
  profile: VizProfile,
  llmAdvicePredicates?: string[],
): Set<string> {
  if (profile === 'llm' && llmAdvicePredicates && llmAdvicePredicates.length > 0) {
    const asLower = new Set(llmAdvicePredicates.map((p) => p.toLowerCase()));
    const fromAdvice = stats
      .filter((s) => asLower.has(s.predicate.toLowerCase()) || asLower.has(s.label.toLowerCase()))
      .map((s) => s.predicate);
    if (fromAdvice.length > 0) return new Set(fromAdvice);
  }

  const ranked = stats
    .map((s) => ({ ...s, score: scorePredicateForProfile(s.label, profile) + scorePredicateForProfile(s.predicate, profile) }))
    .sort((a, b) => (b.score === a.score ? b.count - a.count : b.score - a.score));

  const strong = ranked.filter((r) => r.score > 0).slice(0, 8).map((r) => r.predicate);
  if (strong.length >= 4) return new Set(strong);
  return new Set(stats.slice(0, Math.min(8, stats.length)).map((s) => s.predicate));
}

function parseLlmVizAdvice(reply: string): LlmVizAdvice | null {
  const fenced = reply.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? reply;
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  try {
    const parsed = JSON.parse(objectMatch[0]) as Record<string, unknown>;
    const pred = Array.isArray(parsed.predicates)
      ? parsed.predicates.filter((p): p is string => typeof p === 'string')
      : undefined;
    const hopsRaw = parsed.maxHops;
    const maxHops: HopFilter | undefined = hopsRaw === 'all' || hopsRaw === 1 || hopsRaw === 2 || hopsRaw === 3
      ? hopsRaw
      : undefined;
    const note = typeof parsed.note === 'string' ? parsed.note : undefined;
    return { predicates: pred, maxHops, note };
  } catch {
    return null;
  }
}

function buildCoordinationTriples(limit: number): Triple[] {
  const triples: Triple[] = [];
  const push = (subject: string, predicate: string, object: string) => {
    if (triples.length < limit) triples.push({ subject, predicate, object });
  };

  const run = 'urn:dkg:coordination:run:exp-d-swarm';
  const paranet = 'urn:dkg:paranet:openclaw-benchmark';
  const roundCount = 4;
  const streams = ['core', 'api', 'ui', 'test'];
  const agentsPerStream = 4;
  const tasksPerRoundPerStream = 14;

  push(run, RDF_TYPE, 'urn:dkg:ontology:CoordinationRun');
  push(run, RDFS_LABEL, 'DKG Agent Coordination Experiment');
  push(run, 'urn:dkg:ontology:targetsParanet', paranet);
  push(paranet, RDF_TYPE, 'http://schema.org/Dataset');
  push(paranet, RDFS_LABEL, 'OpenClaw Benchmark Paranet');

  const streamNodes = streams.map((stream) => `urn:dkg:coordination:stream:${stream}`);
  streamNodes.forEach((streamNode, idx) => {
    push(streamNode, RDF_TYPE, 'urn:dkg:ontology:CoordinationStream');
    push(streamNode, RDFS_LABEL, `${streams[idx]} stream`);
    push(run, 'urn:dkg:ontology:hasStream', streamNode);
  });

  const agents: string[] = [];
  streams.forEach((stream, streamIdx) => {
    for (let i = 1; i <= agentsPerStream; i++) {
      const agent = `urn:dkg:coordination:agent:${stream}-${i}`;
      agents.push(agent);
      push(agent, RDF_TYPE, SCHEMA_SOFTWARE_AGENT);
      push(agent, RDFS_LABEL, `${stream}-agent-${i}`);
      push(agent, 'urn:dkg:ontology:memberOfStream', streamNodes[streamIdx]);
      push(run, 'urn:dkg:ontology:hasAgent', agent);
    }
  });

  const tasksByRound: string[][] = [];
  for (let round = 1; round <= roundCount; round++) {
    const roundNode = `urn:dkg:coordination:round:${round}`;
    push(roundNode, RDF_TYPE, 'urn:dkg:ontology:CoordinationRound');
    push(roundNode, RDFS_LABEL, `Round ${round}`);
    push(run, 'urn:dkg:ontology:hasRound', roundNode);

    const roundTasks: string[] = [];
    streams.forEach((stream, streamIdx) => {
      for (let taskN = 1; taskN <= tasksPerRoundPerStream; taskN++) {
        const task = `urn:dkg:coordination:task:r${round}:${stream}:${taskN}`;
        roundTasks.push(task);
        push(task, RDF_TYPE, 'urn:dkg:ontology:CoordinationTask');
        push(task, RDFS_LABEL, `${stream} task ${taskN} (r${round})`);
        push(roundNode, 'urn:dkg:ontology:hasTask', task);
        push(task, 'urn:dkg:ontology:belongsToStream', streamNodes[streamIdx]);

        const owner = agents[(streamIdx * agentsPerStream + (taskN % agentsPerStream)) % agents.length];
        push(task, 'urn:dkg:ontology:assignedTo', owner);

        if (taskN > 1) {
          const prev = `urn:dkg:coordination:task:r${round}:${stream}:${taskN - 1}`;
          push(task, 'urn:dkg:ontology:dependsOn', prev);
        }
        if (streamIdx > 0 && taskN % 3 === 0) {
          const cross = `urn:dkg:coordination:task:r${round}:${streams[streamIdx - 1]}:${taskN}`;
          push(task, 'urn:dkg:ontology:dependsOn', cross);
        }
      }
    });
    tasksByRound.push(roundTasks);
  }

  for (let round = 0; round < tasksByRound.length - 1; round++) {
    const current = tasksByRound[round];
    const next = tasksByRound[round + 1];
    for (let i = 0; i < Math.min(current.length, next.length); i += 4) {
      push(current[i], 'urn:dkg:ontology:handoffTo', next[i]);
    }
  }

  return triples;
}

function GraphTab() {
  const { data: paranetData } = useFetch(fetchParanets, [], 30_000);
  const paranets = paranetData?.paranets ?? [];
  
  const [triples, setTriples] = useState<Triple[] | null>(null);
  const [allTriples, setAllTriples] = useState<Triple[] | null>(null);
  const [typeMap, setTypeMap] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(10000);
  const [refreshKey, setRefreshKey] = useState(0);
  const [datasetMode, setDatasetMode] = useState<DatasetMode>('paranet');
  const [vizProfile, setVizProfile] = useState<VizProfile>('structure');
  const [theme, setTheme] = useState<ThemeKey>('aurora');
  const [graphTotalCount, setGraphTotalCount] = useState<number | null>(null);
  const [coordinationSourceLabel, setCoordinationSourceLabel] = useState('Synthetic from experiment stream patterns');
  const [emptyReason, setEmptyReason] = useState('');
  const [maxHops, setMaxHops] = useState<HopFilter>('all');
  const [predicateStats, setPredicateStats] = useState<PredicateStat[]>([]);
  const [selectedPredicates, setSelectedPredicates] = useState<Set<string>>(new Set());
  const [llmAdvice, setLlmAdvice] = useState<LlmVizAdvice | null>(null);
  const [llmAdviceLoading, setLlmAdviceLoading] = useState(false);
  
  // Filters
  const [typeFilter, setTypeFilter] = useState('');
  const [paranetFilter, setParanetFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showLiterals, setShowLiterals] = useState(true);
  
  // Selected node
  const [selectedNode, setSelectedNode] = useState<NodeDetails | null>(null);
  const activeProfile = VIZ_PROFILES[vizProfile];
  const activeTheme = THEMES[theme];
  const selectedParanet = useMemo(
    () => paranets.find((p: any) => p.id === paranetFilter) ?? null,
    [paranets, paranetFilter],
  );

  const graphViewConfig = useMemo<ViewConfig>(() => ({
    name: `Explorer ${activeTheme.label}`,
    palette: activeTheme.palette,
    paletteOverrides: {
      edgeColor: activeTheme.edge,
      particleColor: activeTheme.glow,
    },
    animation: {
      fadeIn: true,
      linkParticles: activeProfile.glowLinks,
      linkParticleCount: activeProfile.glowLinks ? 1 : 0,
      linkParticleSpeed: 0.005,
      linkParticleColor: activeTheme.glow,
      linkParticleWidth: activeProfile.glowLinks ? 1.2 : 0.8,
      drift: false,
      hoverTrace: activeProfile.glowLinks,
    },
  }), [activeTheme, activeProfile]);

  // Keep "version" opinionated by default, while still allowing manual theme override later.
  useEffect(() => {
    setTheme(activeProfile.theme);
    setMaxHops(activeProfile.defaultHops);
  }, [activeProfile.theme, activeProfile.defaultHops]);

  const applyProfilePredicateSelection = useCallback((stats: PredicateStat[], advice?: LlmVizAdvice | null) => {
    const chosen = selectPredicatesForProfile(stats, vizProfile, advice?.predicates);
    setSelectedPredicates(chosen);
    if (advice?.maxHops) {
      setMaxHops(advice.maxHops);
    } else {
      setMaxHops(VIZ_PROFILES[vizProfile].defaultHops);
    }
  }, [vizProfile]);

  const requestLlmVisualizationAdvice = useCallback(async () => {
    if (!allTriples || allTriples.length === 0 || predicateStats.length === 0) return;
    setLlmAdviceLoading(true);
    try {
      const sampleTriples = allTriples.slice(0, 160).map((t) => `${t.subject} ${t.predicate} ${t.object}`).join('\n');
      const predicateSummary = predicateStats.map((p) => `${p.predicate} (${p.count})`).join('\n');
      const prompt = `You are assisting graph visualization (not data mutation). Given RDF triples, suggest what predicates to highlight.
Return STRICT JSON ONLY:
{"predicates":["..."],"maxHops":"all|1|2|3","note":"short reason"}

Constraints:
- We only change visualization filters/highlights.
- Prefer ontology relations that improve code graph understanding (contains, defines, imports, calls, extends, implements, dependency-like edges).
- Pick up to 8 predicates.

Top predicates:
${predicateSummary}

Sample triples:
${sampleTriples}`;
      const res = await sendChatMessage(prompt);
      const advice = parseLlmVizAdvice(String(res?.reply ?? ''));
      if (advice) {
        setLlmAdvice(advice);
        applyProfilePredicateSelection(predicateStats, advice);
      }
    } catch {
      // Non-fatal: remain on ontology heuristic defaults
    } finally {
      setLlmAdviceLoading(false);
    }
  }, [allTriples, predicateStats, applyProfilePredicateSelection]);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEmptyReason('');
    setTriples(null);
    setSelectedNode(null);
    try {
      if (datasetMode === 'coordination') {
        const coordinationQuery = `CONSTRUCT { ?s ?p ?o } WHERE {
          ?s ?p ?o .
          FILTER(
            REGEX(LCASE(STR(?s)), "coordination|openclaw|stream-|exp-d|dkg-agent|handoff")
            || REGEX(LCASE(STR(?o)), "coordination|openclaw|stream-|exp-d|dkg-agent|handoff")
          )
        } LIMIT ${limit}`;
        const coordinationRes = await executeQuery(coordinationQuery);
        const coordinationQuads = coordinationRes?.result?.quads;
        if (Array.isArray(coordinationQuads) && coordinationQuads.length > 50) {
          const discovered = coordinationQuads.map((q: Triple) => ({
            subject: q.subject,
            predicate: q.predicate,
            object: q.object,
          }));
          setAllTriples(discovered);
          setTypeMap(buildTypeMap(discovered));
          const stats = buildPredicateStats(discovered, 12);
          setPredicateStats(stats);
          applyProfilePredicateSelection(stats, llmAdvice);
          setGraphTotalCount(discovered.length);
          setCoordinationSourceLabel('Loaded from saved coordination-like graph data');
          return;
        }

        const generated = buildCoordinationTriples(limit);
        setAllTriples(generated);
        setTypeMap(buildTypeMap(generated));
        const stats = buildPredicateStats(generated, 12);
        setPredicateStats(stats);
        applyProfilePredicateSelection(stats, llmAdvice);
        setGraphTotalCount(generated.length);
        setCoordinationSourceLabel('Synthetic from experiment stream patterns');
        setEmptyReason('');
        return;
      }

      let sparql = '';
      let quads: unknown[] = [];
      if (selectedParanet?.uri) {
        sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${selectedParanet.uri}> { ?s ?p ?o } } LIMIT ${limit}`;
        const primaryRes = await executeQuery(sparql, selectedParanet.id);
        quads = Array.isArray(primaryRes?.result?.quads) ? primaryRes.result.quads : [];

        // Fallback 1: query through paranet context (backend may scope by paranetId)
        if (quads.length === 0) {
          const scopedRes = await executeQuery(`CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT ${limit}`, selectedParanet.id);
          quads = Array.isArray(scopedRes?.result?.quads) ? scopedRes.result.quads : [];
        }

        // Fallback 2: graph name fuzzy match for deployments where graph URI differs
        if (quads.length === 0) {
          const uriNeedle = escapeSparqlString(selectedParanet.uri.toLowerCase());
          const fuzzyRes = await executeQuery(`CONSTRUCT { ?s ?p ?o } WHERE {
            GRAPH ?g { ?s ?p ?o }
            FILTER(CONTAINS(LCASE(STR(?g)), "${uriNeedle}"))
          } LIMIT ${limit}`);
          quads = Array.isArray(fuzzyRes?.result?.quads) ? fuzzyRes.result.quads : [];
        }
      } else {
        sparql = `CONSTRUCT { ?s ?p ?o } WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } } LIMIT ${limit}`;
        const res = await executeQuery(sparql);
        quads = Array.isArray(res?.result?.quads) ? res.result.quads : [];
      }

      if (selectedParanet?.uri) {
        try {
          const countRes = await executeQuery(
            `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${selectedParanet.uri}> { ?s ?p ?o } }`,
            selectedParanet.id,
          );
          setGraphTotalCount(extractCountFromQueryResult(countRes?.result));
        } catch {
          setGraphTotalCount(null);
        }
      } else {
        setGraphTotalCount(null);
      }

      if (Array.isArray(quads) && quads.length > 0) {
        const rawTriples = quads.map((q: any) => ({
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
        }));
        setAllTriples(rawTriples);
        setTypeMap(buildTypeMap(rawTriples));
        const stats = buildPredicateStats(rawTriples, 12);
        setPredicateStats(stats);
        applyProfilePredicateSelection(stats, llmAdvice);
        setEmptyReason('');
      } else {
        setAllTriples([]);
        setTypeMap(new Map());
        setPredicateStats([]);
        setSelectedPredicates(new Set());
        if (selectedParanet) {
          setEmptyReason('No triples found for this paranet in current node storage. This often means the paranet is not synced yet on this node.');
        } else {
          setEmptyReason('No triples currently available in this node storage.');
        }
      }
    } catch (err: any) {
      setError(err.message);
      setAllTriples([]);
      setTypeMap(new Map());
      setPredicateStats([]);
      setSelectedPredicates(new Set());
    } finally {
      setLoading(false);
    }
  }, [limit, refreshKey, paranetFilter, datasetMode, selectedParanet, applyProfilePredicateSelection, llmAdvice]);

  // Re-filter when filters change (without re-fetching)
  useEffect(() => {
    if (!allTriples) return;
    const filtered = applyFilters(
      allTriples,
      typeMap,
      typeFilter,
      searchQuery,
      selectedPredicates,
      maxHops,
      selectedNode?.uri ?? null,
    );
    if (showLiterals) {
      setTriples(triplesWithLiteralsAsNodes(filtered));
    } else {
      setTriples(filtered.filter(t => isResourceObject(t.object)));
    }
  }, [typeFilter, searchQuery, showLiterals, allTriples, typeMap, selectedPredicates, maxHops, selectedNode]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    if (predicateStats.length === 0) return;
    applyProfilePredicateSelection(predicateStats, llmAdvice);
  }, [vizProfile, predicateStats, llmAdvice, applyProfilePredicateSelection]);

  const handleNodeClick = useCallback((node: any) => {
    if (!allTriples) return;
    const uri = node.id || node.uri || node;
    if (typeof uri !== 'string') return;
    
    const outgoing: Array<{ predicate: string; object: string }> = [];
    const incoming: Array<{ subject: string; predicate: string }> = [];
    
    for (const t of allTriples) {
      if (t.subject === uri) outgoing.push({ predicate: t.predicate, object: t.object });
      if (t.object === uri) incoming.push({ subject: t.subject, predicate: t.predicate });
    }
    
    setSelectedNode({
      uri,
      types: typeMap.get(uri) || [],
      outgoing,
      incoming,
    });
  }, [allTriples, typeMap]);

  return (
    <div className="graph-explorer-layout">
      <div className="graph-explorer-main">
        <div className="card graph-shell" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Toolbar */}
          <div className="graph-toolbar">
            <div className="graph-toolbar-row">
              <select
                className="input"
                value={vizProfile}
                onChange={(e) => setVizProfile(e.target.value as VizProfile)}
                style={{ width: 'auto', minWidth: 220 }}
              >
                {(Object.entries(VIZ_PROFILES) as Array<[VizProfile, VizProfileSpec]>).map(([key, v]) => (
                  <option key={key} value={key}>{v.label}</option>
                ))}
              </select>
              <select
                className="input"
                value={datasetMode}
                onChange={(e) => { setDatasetMode(e.target.value as DatasetMode); setRefreshKey((k) => k + 1); }}
                style={{ width: 'auto', minWidth: 180 }}
              >
                <option value="paranet">Paranet Graph</option>
                <option value="coordination">Agent Coordination Graph</option>
              </select>
              <select
                className="input"
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeKey)}
                style={{ width: 'auto', minWidth: 180 }}
              >
                {Object.entries(THEMES).map(([key, t]) => (
                  <option key={key} value={key}>{t.label}</option>
                ))}
              </select>
              <input
                type="text"
                className="input"
                placeholder="Search nodes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: 180 }}
              />
              <select
                className="input"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{ width: 'auto', minWidth: 140 }}
              >
                {TYPE_FILTERS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <select
                className="input"
                value={paranetFilter}
                onChange={(e) => { setParanetFilter(e.target.value); setRefreshKey(k => k + 1); }}
                style={{ width: 'auto', minWidth: 120 }}
                disabled={datasetMode !== 'paranet'}
              >
                <option value="">All Paranets</option>
                {paranets.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <span className="graph-mode-description">{activeProfile.description}</span>
            </div>
            <div className="graph-toolbar-row">
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Depth</label>
              <div className="range-pills">
                {(['all', 1, 2, 3] as const).map((h) => (
                  <button
                    key={String(h)}
                    className={`range-pill ${maxHops === h ? 'active' : ''}`}
                    onClick={() => setMaxHops(h)}
                    type="button"
                  >
                    {h === 'all' ? 'All' : `${h} hop`}
                  </button>
                ))}
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showLiterals}
                  onChange={(e) => setShowLiterals(e.target.checked)}
                />
                Show literals
              </label>
              <select
                className="input"
                style={{ width: 'auto', minWidth: 100 }}
                value={limit}
                onChange={(e) => { setLimit(Number(e.target.value)); setRefreshKey(k => k + 1); }}
              >
                {GRAPH_LIMITS.map((n) => (
                  <option key={n} value={n}>Limit {n}</option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
              {vizProfile === 'llm' && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { void requestLlmVisualizationAdvice(); }}
                  disabled={llmAdviceLoading || !allTriples || allTriples.length === 0}
                  title="Ask LLM what predicates and depth to emphasize"
                >
                  {llmAdviceLoading ? 'LLM analyzing…' : 'LLM Suggest Highlights'}
                </button>
              )}
              {datasetMode === 'coordination' && (
                <span className="graph-info-pill">{coordinationSourceLabel}</span>
              )}
              {vizProfile === 'llm' && llmAdvice?.note && (
                <span className="graph-info-pill">{llmAdvice.note}</span>
              )}
              {datasetMode === 'paranet' && paranetFilter && graphTotalCount != null && (
                <span className="graph-info-pill">
                  Showing up to {limit.toLocaleString()} of {graphTotalCount.toLocaleString()} paranet triples
                </span>
              )}
              {triples && !loading && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {triples.length} triples
                </span>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="graph-legend">
            {TYPE_FILTERS.slice(1).map((t) => (
              <span key={t.value} className="graph-legend-item">
                <span className="graph-legend-dot" style={{ background: activeTheme.typeColors[t.value] || activeTheme.defaultNode }} />
                {t.label}
              </span>
            ))}
          </div>
          {predicateStats.length > 0 && (
            <div className="graph-predicate-filters">
              {predicateStats.map((p) => {
                const active = selectedPredicates.has(p.predicate);
                return (
                  <button
                    key={p.predicate}
                    type="button"
                    className={`graph-predicate-chip ${active ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedPredicates((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.predicate)) next.delete(p.predicate);
                        else next.add(p.predicate);
                        return next;
                      });
                    }}
                    title={p.predicate}
                  >
                    {p.label} ({p.count})
                  </button>
                );
              })}
              <button
                type="button"
                className="graph-predicate-chip"
                onClick={() => setSelectedPredicates(new Set(predicateStats.map((p) => p.predicate)))}
              >
                All
              </button>
            </div>
          )}

          {/* Graph */}
          {error && <div style={{ padding: 16, color: 'var(--error)' }}>{error}</div>}
          {loading && !triples && <div className="loading" style={{ minHeight: 400 }}>Loading graph…</div>}
          {triples && triples.length === 0 && !loading && (
            <div className="empty-state" style={{ minHeight: 400 }}>
              {emptyReason || 'No triples match the current filters'}
            </div>
          )}
          {triples && triples.length > 0 && (
            <div className="graph-viewport" style={{ flex: 1, minHeight: 400 }}>
              <RdfGraph
                data={triples}
                format="triples"
                options={{
                  labelMode: 'humanized',
                  renderer: '2d',
                  style: {
                    classColors: activeTheme.typeColors,
                    defaultNodeColor: activeTheme.defaultNode,
                    defaultEdgeColor: activeTheme.edge,
                    edgeWidth: activeProfile.edgeWidth,
                  },
                  hexagon: { baseSize: 3, minSize: 2, maxSize: 5, scaleWithDegree: true },
                }}
                viewConfig={graphViewConfig}
                style={{ width: '100%', height: '100%' }}
                onNodeClick={handleNodeClick}
              >
                <GraphZoomToFit />
              </RdfGraph>
            </div>
          )}
        </div>
      </div>

      {/* Details Panel */}
      {selectedNode && (
        <div className="graph-details-panel">
          <div className="graph-details-header">
            <h3>Node Details</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedNode(null)}>×</button>
          </div>
          <div className="graph-details-body">
            <div className="graph-details-section">
              <div className="graph-details-label">URI</div>
              <div className="graph-details-value mono">{selectedNode.uri}</div>
            </div>
            
            {selectedNode.types.length > 0 && (
              <div className="graph-details-section">
                <div className="graph-details-label">Types</div>
                {selectedNode.types.map((t, i) => (
                  <div key={i} className="graph-details-value">
                    <span className="graph-legend-dot" style={{ background: activeTheme.typeColors[t] || activeTheme.defaultNode }} />
                    {shortLabel(t)}
                  </div>
                ))}
              </div>
            )}
            
            {selectedNode.outgoing.length > 0 && (
              <div className="graph-details-section">
                <div className="graph-details-label">Properties ({selectedNode.outgoing.length})</div>
                <div className="graph-details-triples">
                  {selectedNode.outgoing.slice(0, 20).map((t, i) => (
                    <div key={i} className="graph-details-triple">
                      <span className="predicate">{shortLabel(t.predicate)}</span>
                      <span className="object" title={t.object}>{shortLabel(t.object)}</span>
                    </div>
                  ))}
                  {selectedNode.outgoing.length > 20 && (
                    <div className="graph-details-more">+{selectedNode.outgoing.length - 20} more</div>
                  )}
                </div>
              </div>
            )}
            
            {selectedNode.incoming.length > 0 && (
              <div className="graph-details-section">
                <div className="graph-details-label">Referenced by ({selectedNode.incoming.length})</div>
                <div className="graph-details-triples">
                  {selectedNode.incoming.slice(0, 10).map((t, i) => (
                    <div key={i} className="graph-details-triple">
                      <span className="subject" title={t.subject}>{shortLabel(t.subject)}</span>
                      <span className="predicate">{shortLabel(t.predicate)}</span>
                    </div>
                  ))}
                  {selectedNode.incoming.length > 10 && (
                    <div className="graph-details-more">+{selectedNode.incoming.length - 10} more</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const TEMPLATES: Record<string, string> = {
  'All triples (limit 100)': 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100',
  'All agents': `SELECT ?name ?peerId WHERE {
  ?agent <urn:dkg:agentName> ?name ;
         <urn:dkg:peerId> ?peerId .
}`,
  'KCs in a paranet': `SELECT ?kc ?status WHERE {
  GRAPH ?meta {
    ?kc a <urn:dkg:KC> ;
        <urn:dkg:status> ?status .
  }
} LIMIT 50`,
  'Count triples per graph': `SELECT ?g (COUNT(*) AS ?count) WHERE {
  GRAPH ?g { ?s ?p ?o }
} GROUP BY ?g ORDER BY DESC(?count)`,
};

function SparqlTab() {
  const [sparql, setSparql] = useState(TEMPLATES['All triples (limit 100)']);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'json' | 'graph'>('table');
  const [execTime, setExecTime] = useState<number | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    const start = performance.now();
    try {
      const res = await executeQuery(sparql);
      const duration = Math.round(performance.now() - start);
      setExecTime(duration);
      const raw = res.result;
      setResult(raw?.bindings ?? raw);
    } catch (err: any) {
      setError(err.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [sparql]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  }, [run]);

  return (
    <div>
      <div className="toolbar">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="input"
            style={{ width: 'auto', minWidth: 200 }}
            onChange={(e) => { if (e.target.value) setSparql(e.target.value); }}
            defaultValue=""
          >
            <option value="" disabled>Templates...</option>
            {Object.entries(TEMPLATES).map(([name, q]) => (
              <option key={name} value={q}>{name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {execTime != null && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{execTime}ms</span>}
          <button className="btn btn-primary" onClick={run} disabled={loading}>
            {loading ? 'Running...' : 'Run Query'}
          </button>
        </div>
      </div>

      <textarea
        className="sparql-editor"
        value={sparql}
        onChange={(e) => setSparql(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={8}
        placeholder="Enter SPARQL query... (Ctrl+Enter to run)"
        spellCheck={false}
      />

      {error && (
        <div className="card" style={{ borderColor: 'var(--error)', marginTop: 12 }}>
          <div style={{ color: 'var(--error)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>{error}</div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="result-tabs">
            <button className={`result-tab ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')}>Table</button>
            <button className={`result-tab ${viewMode === 'graph' ? 'active' : ''}`} onClick={() => setViewMode('graph')}>Graph</button>
            <button className={`result-tab ${viewMode === 'json' ? 'active' : ''}`} onClick={() => setViewMode('json')}>JSON</button>
          </div>

          {viewMode === 'table' && <ResultTable result={result} />}
          {viewMode === 'graph' && <ResultGraph result={result} />}
          {viewMode === 'json' && <div className="json-view">{JSON.stringify(result, null, 2)}</div>}
        </div>
      )}
    </div>
  );
}

function ResultTable({ result }: { result: any }) {
  if (!Array.isArray(result) || result.length === 0) {
    return <div className="empty-state">No results</div>;
  }

  const columns = Object.keys(result[0]);

  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
        {result.length} result{result.length !== 1 ? 's' : ''}
      </div>
      <table className="data-table">
        <thead>
          <tr>{columns.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {result.map((row: any, i: number) => (
            <tr key={i}>
              {columns.map(c => (
                <td key={c} className="mono" style={{ fontSize: 12 }}>
                  {typeof row[c] === 'string' && row[c].length > 80
                    ? <span title={row[c]}>{row[c].slice(0, 80)}...</span>
                    : String(row[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultGraph({ result }: { result: any }) {
  if (!Array.isArray(result) || result.length === 0) {
    return <div className="graph-container">No data to visualize</div>;
  }

  const hasTripleShape = result[0] && ('s' in result[0]) && ('p' in result[0]) && ('o' in result[0]);
  if (!hasTripleShape) {
    return <div className="graph-container">Graph view requires SELECT ?s ?p ?o queries</div>;
  }

  const nodesMap = new Map<string, { id: string; label: string; type: string }>();
  const edges: Array<{ source: string; target: string; label: string }> = [];

  for (const row of result) {
    const s = String(row.s);
    const p = String(row.p);
    const o = String(row.o);

    if (!nodesMap.has(s)) {
      nodesMap.set(s, { id: s, label: shortLabel(s), type: 'resource' });
    }

    const isLiteral = !o.startsWith('http') && !o.startsWith('urn:');
    if (!isLiteral) {
      if (!nodesMap.has(o)) {
        nodesMap.set(o, { id: o, label: shortLabel(o), type: 'resource' });
      }
      edges.push({ source: s, target: o, label: shortLabel(p) });
    } else {
      const litId = `${s}__${p}__lit`;
      nodesMap.set(litId, { id: litId, label: o.length > 30 ? o.slice(0, 30) + '...' : o, type: 'literal' });
      edges.push({ source: s, target: litId, label: shortLabel(p) });
    }
  }

  const nodes = Array.from(nodesMap.values());
  const nodeRadius = 6;
  const width = 800;
  const height = 400;

  // Simple circular layout (force layout would require a library)
  const positions = nodes.map((_, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const r = Math.min(width, height) * 0.35;
    return {
      x: width / 2 + r * Math.cos(angle),
      y: height / 2 + r * Math.sin(angle),
    };
  });

  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));

  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        {nodes.length} nodes, {edges.length} edges
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ background: 'var(--bg-input)', borderRadius: 'var(--radius)' }}>
        <defs>
          <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="#6b7280" />
          </marker>
        </defs>

        {edges.map((e, i) => {
          const si = nodeIndex.get(e.source);
          const ti = nodeIndex.get(e.target);
          if (si == null || ti == null) return null;
          const s = positions[si];
          const t = positions[ti];
          const mx = (s.x + t.x) / 2;
          const my = (s.y + t.y) / 2;
          return (
            <g key={i}>
              <line x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                stroke="#374151" strokeWidth={1} markerEnd="url(#arrowhead)" />
              <text x={mx} y={my - 4} textAnchor="middle" fontSize={8} fill="#6b7280">{e.label}</text>
            </g>
          );
        })}

        {nodes.map((n, i) => {
          const p = positions[i];
          const fill = n.type === 'literal' ? '#f59e0b' : '#3b82f6';
          return (
            <g key={n.id}>
              <circle cx={p.x} cy={p.y} r={nodeRadius} fill={fill} />
              <text x={p.x} y={p.y + nodeRadius + 12} textAnchor="middle" fontSize={9} fill="#e5e7eb">{n.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ParanetsTab() {
  const { data } = useFetch(fetchParanets, [], 30_000);
  const paranets = data?.paranets ?? [];
  const navigate = useNavigate();

  return (
    <div>
      {paranets.length === 0 ? (
        <div className="empty-state">No paranets found</div>
      ) : (
        <div className="paranet-list">
          {paranets.map((p: any) => (
            <div key={p.id} className="paranet-card" onClick={() => {
              navigate('/explorer');
              // Auto-fill a query for this paranet's KCs
            }}>
              <h3>{p.name}</h3>
              <p>{p.description || p.uri}</p>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                {p.isSystem && <span className="badge badge-info" style={{ marginRight: 4 }}>system</span>}
                <span className="mono">{shortId(p.id, 16)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PublishTab() {
  const { data: paranetData } = useFetch(fetchParanets, [], 30_000);
  const paranets = paranetData?.paranets?.filter((p: any) => !p.isSystem) ?? [];

  const [paranetId, setParanetId] = useState('');
  const [turtleInput, setTurtleInput] = useState(
`@prefix ex: <http://example.org/> .

ex:Alice ex:knows ex:Bob .
ex:Alice ex:name "Alice" .
ex:Bob ex:name "Bob" .`
  );
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const publish = async () => {
    if (!paranetId) { setError('Select a paranet'); return; }
    setLoading(true);
    setError(null);
    try {
      const quads = parseTurtleToQuads(turtleInput);
      if (quads.length === 0) { setError('No valid triples parsed'); setLoading(false); return; }
      const res = await publishTriples(paranetId, quads);
      setResult(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">Publish Triples</div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Paranet</label>
          <select className="input" value={paranetId} onChange={(e) => setParanetId(e.target.value)}>
            <option value="">Select paranet...</option>
            {paranets.map((p: any) => (
              <option key={p.id} value={p.id}>{p.name} ({shortId(p.id)})</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Triples (Turtle format)</label>
          <textarea
            className="sparql-editor"
            value={turtleInput}
            onChange={(e) => setTurtleInput(e.target.value)}
            rows={10}
            placeholder="Enter triples in Turtle format..."
            spellCheck={false}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={publish} disabled={loading}>
            {loading ? 'Publishing...' : 'Publish'}
          </button>
          {error && <span style={{ color: 'var(--error)', fontSize: 13 }}>{error}</span>}
        </div>

        {result && (
          <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-input)', borderRadius: 'var(--radius)' }}>
            <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 4 }}>Published successfully</div>
            <div className="json-view" style={{ maxHeight: 200 }}>{JSON.stringify(result, null, 2)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryTab() {
  const { data } = useFetch(() => fetchQueryHistory(50), [], 10_000);
  const history = data?.history ?? [];
  const navigate = useNavigate();

  return (
    <div>
      {history.length === 0 ? (
        <div className="empty-state">No query history yet</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Query</th>
                <th>Duration</th>
                <th>Results</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h: any) => (
                <tr key={h.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/explorer')}>
                  <td>{formatTime(h.ts)}</td>
                  <td className="mono" style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
                    {h.sparql}
                  </td>
                  <td>{h.duration_ms != null ? `${h.duration_ms}ms` : '—'}</td>
                  <td>{h.result_count ?? '—'}</td>
                  <td>{h.error ? <span className="badge badge-error">error</span> : <span className="badge badge-success">ok</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SavedTab() {
  const { data, refresh } = useFetch(fetchSavedQueries, []);
  const queries = data?.queries ?? [];
  const [name, setName] = useState('');
  const [sparql, setSparql] = useState('');

  const save = async () => {
    if (!name || !sparql) return;
    await createSavedQuery({ name, sparql });
    setName('');
    setSparql('');
    refresh();
  };

  const remove = async (id: number) => {
    await deleteSavedQuery(id);
    refresh();
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">Save a Query</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" placeholder="Query name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 300 }} />
          <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
        </div>
        <textarea className="sparql-editor" value={sparql} onChange={(e) => setSparql(e.target.value)} rows={4} placeholder="SPARQL..." spellCheck={false} />
      </div>

      {queries.length === 0 ? (
        <div className="empty-state">No saved queries</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Query</th>
                <th>Saved</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q: any) => (
                <tr key={q.id}>
                  <td style={{ fontWeight: 600 }}>{q.name}</td>
                  <td className="mono" style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
                    {q.sparql}
                  </td>
                  <td>{formatTime(q.created_at)}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => remove(q.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Utility ---

function shortLabel(uri: string): string {
  if (uri.includes('#')) return uri.split('#').pop()!;
  const parts = uri.split('/');
  return parts[parts.length - 1] || uri;
}

/**
 * Minimalist Turtle → quads parser for the publish form.
 * Handles simple triples with prefixes. Not a full Turtle parser.
 */
function parseTurtleToQuads(input: string): Array<{ subject: string; predicate: string; object: string; graph: string }> {
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
  const prefixes: Record<string, string> = {};

  const lines = input.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  for (const line of lines) {
    const prefixMatch = line.match(/^@prefix\s+(\w*):?\s+<([^>]+)>\s*\.?\s*$/);
    if (prefixMatch) {
      prefixes[prefixMatch[1]] = prefixMatch[2];
      continue;
    }

    // Simple triple: subject predicate object .
    const tripleMatch = line.match(/^(\S+)\s+(\S+)\s+(.+?)\s*\.\s*$/);
    if (!tripleMatch) continue;

    const [, s, p, o] = tripleMatch;
    quads.push({
      subject: expandPrefixed(s, prefixes),
      predicate: expandPrefixed(p, prefixes),
      object: o.startsWith('"') ? o.replace(/^"|"$/g, '') : expandPrefixed(o, prefixes),
      graph: '',
    });
  }

  return quads;
}

function expandPrefixed(term: string, prefixes: Record<string, string>): string {
  if (term.startsWith('<') && term.endsWith('>')) return term.slice(1, -1);
  const colonIdx = term.indexOf(':');
  if (colonIdx > 0) {
    const prefix = term.slice(0, colonIdx);
    if (prefixes[prefix]) return prefixes[prefix] + term.slice(colonIdx + 1);
  }
  return term;
}
