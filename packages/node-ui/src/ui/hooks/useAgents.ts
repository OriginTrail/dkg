/**
 * Load first-class agent entities from a project's `meta` sub-graph and
 * expose them as typed summaries keyed by URI. This is the data side of
 * AgentChip — every decision / task / commit carries
 * `prov:wasAttributedTo <agent URI>`, and the chip renders the agent's
 * name, framework, operator, and a deterministic color.
 *
 * Agents are project-scoped (you might run different agents in a
 * book-research project vs. this code project), so the hook takes the
 * active contextGraphId and re-fetches when it changes.
 */
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { executeQuery } from '../api.js';

const AGENT_NS = 'http://dkg.io/ontology/agent/';
const SCHEMA_NAME = 'http://schema.org/name';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

export type AgentKind = 'human' | 'ai';

export interface AgentSummary {
  uri: string;
  /** Display name — "Claude Code", "branarakic", "Hermes". */
  name: string;
  /** "human" or "ai"; derived from rdf:type via HumanAgent / AIAgent. */
  kind: AgentKind;
  /** Runtime framework: "claude-code" / "openclaw" / "hermes" / "human". */
  framework?: string;
  /** For AI agents: the operator's agent URI (the human who runs it). */
  operatorUri?: string;
  /** Resolved operator name, set once the full agent map is built. */
  operatorName?: string;
  /**
   * Wallet public key (EVM-style 0x… address). This IS the agent's
   * identity on the DKG — signatures, reputation, TRAC stake all hang
   * off this, not off the URI.
   */
  walletAddress?: string;
  /** libp2p peer id, if known. */
  peerId?: string;
  /** Avatar URL or data: URI. */
  avatar?: string;
  /** Short bio / trust note (free text). */
  reputation?: string;
  /** Deterministic color derived from the URI — stable across views. */
  color: string;
}

export interface AgentsData {
  agents: Map<string, AgentSummary>;
  list: AgentSummary[];
  loading: boolean;
  error?: string;
  get: (uri: string) => AgentSummary | undefined;
  /**
   * Open an agent's profile page. Installed by the active ProjectView
   * (which knows the enclosing project id); any AgentChip anywhere in
   * the tree reads this off context and uses it as the default click
   * handler. Defaults to a no-op so chips still render fine outside a
   * ProjectView (e.g. in tests or standalone demos).
   */
  openAgent: (uri: string) => void;
}

// ── SPARQL ────────────────────────────────────────────────────
function metaGraphFilter(contextGraphId: string): string {
  const prefix = `did:dkg:context-graph:${contextGraphId}/meta`;
  return `FILTER(strstarts(str(?g), "${prefix.replace(/"/g, '\\"')}"))`;
}

function buildAgentsQuery(contextGraphId: string): string {
  return `PREFIX ag: <${AGENT_NS}>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?a ?kind ?name ?label ?fw ?op ?wallet ?peerId ?avatar ?reputation
WHERE {
  GRAPH ?g {
    ?a a ag:Agent .
    OPTIONAL { ?a a ag:HumanAgent . BIND("human" AS ?kind) }
    OPTIONAL { ?a a ag:AIAgent    . BIND("ai"    AS ?kindAi) }
    OPTIONAL { ?a schema:name        ?name }
    OPTIONAL { ?a rdfs:label         ?label }
    OPTIONAL { ?a ag:framework       ?fw }
    OPTIONAL { ?a ag:operator        ?op }
    OPTIONAL { ?a ag:walletAddress   ?wallet }
    OPTIONAL { ?a ag:peerId          ?peerId }
    OPTIONAL { ?a ag:avatar          ?avatar }
    OPTIONAL { ?a ag:reputation      ?reputation }
  }
  ${metaGraphFilter(contextGraphId)}
}`;
}

// ── Literal / IRI helpers ─────────────────────────────────────
// `/api/query` can return SPARQL-JSON binding cells (`{ value, type, … }`)
// rather than bare strings — running `.match()` / `.trim()` on the object
// form throws. Normalise first.
function bindingValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw === null || raw === undefined ? '' : String(raw);
  }
  return String(v);
}

function stripLiteral(value: unknown): string {
  const raw = bindingValue(value);
  if (!raw) return '';
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  return raw;
}

function stripIri(value: unknown): string {
  const raw = bindingValue(value);
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
}

// ── Color derivation ──────────────────────────────────────────
// Stable hash -> HSL hue. Two different agents will collide if their
// URIs hash to neighboring hues, but that's fine for 5-10 agents on
// screen; the name + framework badge still distinguishes them.
function colorForUri(uri: string): string {
  let h = 0;
  for (let i = 0; i < uri.length; i++) {
    h = (h * 31 + uri.charCodeAt(i)) | 0;
  }
  const hue = ((h % 360) + 360) % 360;
  // Skip red-green-blue primary bands to avoid colliding with status
  // colors (red = rejected, green = verified). Rotate hue into cooler
  // or warmer mid-tones.
  const biasedHue = (hue + 25) % 360;
  return `hsl(${biasedHue}, 55%, 58%)`;
}

// ── Parsing ───────────────────────────────────────────────────
function parseAgents(rows: Array<Record<string, any>>): Map<string, AgentSummary> {
  const out = new Map<string, AgentSummary>();
  for (const row of rows) {
    const uri = stripIri(row.a);
    if (!uri) continue;
    // If we've already seen this URI (e.g. duplicate binding rows from
    // the HumanAgent / AIAgent OPTIONAL union), merge fields instead of
    // overwriting.
    const prev = out.get(uri);
    const kind: AgentKind = stripLiteral(row.kindAi) === 'ai' || stripLiteral(row.kind) === 'ai'
      ? 'ai'
      : (stripLiteral(row.kind) === 'human' ? 'human' : (prev?.kind ?? 'ai'));

    const agent: AgentSummary = {
      uri,
      name: stripLiteral(row.name) || stripLiteral(row.label) || uri.split(':').pop() || uri,
      kind,
      framework:     stripLiteral(row.fw)         || prev?.framework,
      operatorUri:   stripIri(row.op)             || prev?.operatorUri,
      walletAddress: stripLiteral(row.wallet)     || prev?.walletAddress,
      peerId:        stripLiteral(row.peerId)     || prev?.peerId,
      avatar:        stripLiteral(row.avatar)     || prev?.avatar,
      reputation:    stripLiteral(row.reputation) || prev?.reputation,
      color: colorForUri(uri),
    };
    // Humans get a stable "human" framework for UI uniformity.
    if (agent.kind === 'human' && !agent.framework) agent.framework = 'human';
    out.set(uri, agent);
  }
  // Second pass: resolve operator URIs to names so the chip can show
  // "Claude Code · branarakic" directly.
  for (const agent of out.values()) {
    if (agent.operatorUri) {
      const op = out.get(agent.operatorUri);
      if (op) agent.operatorName = op.name;
    }
  }
  return out;
}

// ── Hook ──────────────────────────────────────────────────────
export function useAgents(contextGraphId: string | undefined): AgentsData {
  const [agents, setAgents] = useState<Map<string, AgentSummary>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const getRef = useRef<Map<string, AgentSummary>>(new Map());

  useEffect(() => {
    if (!contextGraphId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const result = await executeQuery(buildAgentsQuery(contextGraphId), contextGraphId);
        if (cancelled) return;
        const rows = ((result as any)?.result?.bindings ?? []) as Array<Record<string, any>>;
        const parsed = parseAgents(rows);
        setAgents(parsed);
        getRef.current = parsed;
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contextGraphId]);

  const get = useCallback((uri: string) => getRef.current.get(uri), []);
  const list = React.useMemo(() => [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), [agents]);
  // `openAgent` is a ref-based no-op by default; ProjectView overrides
  // it via AgentsContext.Provider with a function that opens a tab.
  const openAgent = useCallback((_uri: string) => { /* overridden via context */ }, []);
  return { agents, list, loading, error, get, openAgent };
}

// ── Shared context (so one load serves every AgentChip) ──────────
export const AgentsContext = React.createContext<AgentsData | null>(null);
export function useAgentsContext(): AgentsData | null {
  return useContext(AgentsContext);
}
