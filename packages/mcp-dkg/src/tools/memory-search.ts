/**
 * `dkg_memory_search` — trust-weighted, multi-tier, multi-CG-fan-out
 * recall over agent-context WM/SWM/VM (and the project CG's matching
 * layers when supplied).
 *
 * Per parity-matrix v0.7 §4.19: re-implementation of the adapter's
 * `DkgMemorySearchManager` (`packages/adapter-openclaw/src/DkgMemoryPlugin.ts`).
 * Reasons for the re-implementation rather than a direct re-export:
 *   - The adapter's manager requires a `DkgDaemonClient` (different
 *     surface from mcp-dkg's `DkgClient`) and a `DkgMemorySessionResolver`
 *     (per-conversation session state — mcp-dkg has no session concept).
 *   - The manager's auto-recall complexity (single-flight, query-cap,
 *     conversation-scoped session keying) is OpenClaw-hook-specific and
 *     not needed in mcp-dkg.
 *   - mcp-dkg's `DkgClient.query({view, agentAddress})` already supports
 *     the routing knobs needed for the 6-layer fan-out.
 *
 * IMPORTANT: trust weights and the layer-string vocabulary are duplicated
 * from `packages/adapter-openclaw/src/DkgMemoryPlugin.ts:285-301` and
 * `packages/adapter-openclaw/src/types.ts:217-223`. KEEP THEM IN SYNC.
 * qa-engineer's verification fixture (verification-plan §2.2 Case 3)
 * inverts the expected ordering so a naive ranker fails — that's the
 * test-time guard. Drift this comment if those weights ever change here
 * or there. The eventual deduplication path is hoisting the manager into
 * a shared `packages/dkg-memory` workspace package (matrix §4.19, A2).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';
import { bindingValue, escapeSparqlLiteral } from '../sparql.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const errResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const formatError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ── Layer model ─────────────────────────────────────────────────────
// Source of truth: `packages/adapter-openclaw/src/types.ts:217-223`.
type MemoryLayer =
  | 'agent-context-wm'
  | 'agent-context-swm'
  | 'agent-context-vm'
  | 'project-wm'
  | 'project-swm'
  | 'project-vm';

// Source of truth: `packages/adapter-openclaw/src/DkgMemoryPlugin.ts:285-301`.
const TRUST_WEIGHT: Record<MemoryLayer, number> = {
  'agent-context-wm': 1.0,
  'agent-context-swm': 1.15,
  'agent-context-vm': 1.3,
  'project-wm': 1.0,
  'project-swm': 1.15,
  'project-vm': 1.3,
};

// Trust order for cross-layer dedup: VM > SWM > WM. Tier is based on
// the view, not the context graph (an agent-context VM ties with a
// project VM). Source: `DkgMemoryPlugin.ts:391-398`.
const TRUST_ORDER: Record<MemoryLayer, number> = {
  'agent-context-vm': 3,
  'project-vm': 3,
  'agent-context-swm': 2,
  'project-swm': 2,
  'agent-context-wm': 1,
  'project-wm': 1,
};

// Same canonical identifier used by the adapter so memory written via
// either surface lands in the same agent-context graph. Source:
// `packages/adapter-openclaw/src/DkgMemoryPlugin.ts:55`.
const AGENT_CONTEXT_GRAPH = 'agent-context';

const AGENT_DID_PREFIX = 'did:dkg:agent:';

/**
 * The DKG V10 query engine routes WM reads by raw peer ID, NOT the DID
 * form. A DID-form input gets routed to a non-existent namespace and
 * silently returns empty bindings. Mirror the adapter's normalisation
 * at the consumption boundary. Source: `DkgMemoryPlugin.ts:762-766`.
 */
function toAgentPeerId(agentAddress: string): string {
  return agentAddress.startsWith(AGENT_DID_PREFIX)
    ? agentAddress.slice(AGENT_DID_PREFIX.length)
    : agentAddress;
}

interface LayerPlan {
  layer: MemoryLayer;
  contextGraphId: string;
  view: 'working-memory' | 'shared-working-memory' | 'verified-memory';
}

/**
 * Per-hit shape preserves SKILL.md §6.3's combined-string `layer`
 * contract (`agent-context-wm | … | project-vm`) so consumers reading
 * hits from this MCP, the OpenClaw adapter, or the daemon directly see
 * the same agent-facing identifier. `contextGraphId` and `trustWeight`
 * are surfaced as first-class fields alongside it — the prefix
 * redundancy is intentional, the combined string is the SKILL contract
 * and the split fields are agent ergonomics.
 *
 * Synthetic `path` mirrors the adapter shape `dkg://{cg}/{layer}/{hash}`
 * (`packages/adapter-openclaw/src/DkgMemoryPlugin.ts:410`) so tooling
 * consuming hits from either surface can dedup or jump-to-source on
 * the same identifier.
 */
interface Hit {
  contextGraphId: string;
  layer: MemoryLayer;
  trustWeight: number;
  score: number;
  entityUri: string;
  snippet: string;
  path: string;
}

/**
 * Decompose the SKILL.md combined `layer` string into human-readable
 * CG-and-tier halves for the text-mode renderer. Pure rendering
 * helper — does NOT mutate the contract on `Hit.layer` (which stays
 * the SKILL-canonical combined form). Returns `{ tier: 'WM' | 'SWM'
 * | 'VM' }`; the CG half is the explicit `Hit.contextGraphId`.
 */
function tierFromCombinedLayer(layer: MemoryLayer): 'WM' | 'SWM' | 'VM' {
  if (layer.endsWith('-vm')) return 'VM';
  if (layer.endsWith('-swm')) return 'SWM';
  return 'WM';
}

function computeKeywordOverlap(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0.5;
  const lower = text.toLowerCase();
  const hits = keywords.filter((k) => lower.includes(k)).length;
  return hits / keywords.length;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '…';
}

/**
 * djb2-style non-cryptographic hash. Keeps text-only-fallback dedup keys
 * stable and unique across full text content (not just the first 80
 * chars). Matches the adapter's `hashString` at
 * `packages/adapter-openclaw/src/DkgMemoryPlugin.ts:779-785` byte-for-byte
 * so a memory written via either surface dedups identically when the
 * same text surfaces through multiple layers without a `?uri`.
 */
function hashString(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function registerMemorySearchTool(
  server: McpServer,
  client: DkgClient,
  _config: DkgConfig,
): void {
  server.registerTool(
    'dkg_memory_search',
    {
      title: 'Search DKG-backed Memory',
      description:
        'Search agent-backed memory across WM/SWM/VM layers in the ' +
        'agent-context graph (and an optional project graph) with ' +
        'trust-weighted ranking. Higher-trust layers (VM > SWM > WM) ' +
        'collapse lower-trust hits for the same entity URI. Use this for ' +
        '"ask my memory anything" recall — for ad-hoc SPARQL prefer ' +
        '`dkg_query`.',
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe('Free-text query (case-insensitive, ≥2 chars)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Maximum hits to return after ranking + dedup'),
        projectId: z
          .string()
          .optional()
          .describe(
            'Optional project context-graph id. When supplied, fan-out adds ' +
              "the project's WM/SWM/VM layers to the agent-context layers.",
          ),
      },
    },
    async ({ query, limit, projectId }): Promise<ToolResult> => {
      const trimmed = query.trim();
      if (trimmed.length < 2) {
        return errResult('"query" is required (non-empty string, ≥2 chars).');
      }
      const cap = Math.floor(Math.max(1, Math.min(100, limit ?? 20)));

      // The query engine requires the agent's raw peer ID for WM view
      // routing. Probe the daemon's identity once per call; without this,
      // the WM layer fan-out silently returns empty bindings.
      let agentAddress: string | undefined;
      try {
        const identity = await client.getAgentIdentity();
        // Prefer raw `peerId` (the daemon emits it directly); fall back to
        // stripping the DID prefix off `agentAddress` if `peerId` is absent
        // on older daemons.
        const raw = identity.peerId ?? (identity.agentAddress ? toAgentPeerId(identity.agentAddress) : undefined);
        if (raw && raw.length > 0) agentAddress = raw;
      } catch {
        // Identity probe failure is recoverable as long as some layer
        // doesn't need it. We try the call anyway; if every layer 400s
        // the user gets a single backend-not-ready error below.
      }
      if (!agentAddress) {
        return errResult(
          'memory_search backend not ready: daemon agent identity is not resolvable. ' +
            'Retry shortly. If the failure persists, check that the daemon is healthy ' +
            '(`dkg status`) and that the API token is valid.',
        );
      }

      // Tokenise into ≥2-char keywords; the daemon's SPARQL filter strips
      // shorter tokens silently, so a 1-char query would look like "no
      // hits". We reject explicitly above instead.
      const keywords = trimmed.toLowerCase().split(/\s+/).filter((k) => k.length >= 2);
      if (keywords.length === 0) return ok(`No hits for "${trimmed}".`);

      const filterClause = keywords
        .map((k) => `CONTAINS(LCASE(STR(?text)), "${escapeSparqlLiteral(k)}")`)
        .join(' || ');

      // Permissive shape: any subject with any literal of length ≥20
      // matching at least one keyword. The 20-char floor strips tiny
      // metadata literals (booleans, numeric enums, single-word labels).
      // Source: `DkgMemoryPlugin.ts:237-243`.
      const sparql = `SELECT ?uri ?pred ?text WHERE {
  ?uri ?pred ?text .
  FILTER(isLiteral(?text))
  FILTER(STRLEN(STR(?text)) >= 20)
  FILTER(${filterClause})
}
LIMIT ${cap}`;

      const plans: LayerPlan[] = [
        { layer: 'agent-context-wm', contextGraphId: AGENT_CONTEXT_GRAPH, view: 'working-memory' },
        { layer: 'agent-context-swm', contextGraphId: AGENT_CONTEXT_GRAPH, view: 'shared-working-memory' },
        { layer: 'agent-context-vm', contextGraphId: AGENT_CONTEXT_GRAPH, view: 'verified-memory' },
      ];
      if (projectId) {
        plans.push(
          { layer: 'project-wm', contextGraphId: projectId, view: 'working-memory' },
          { layer: 'project-swm', contextGraphId: projectId, view: 'shared-working-memory' },
          { layer: 'project-vm', contextGraphId: projectId, view: 'verified-memory' },
        );
      }
      const searchedLayers: MemoryLayer[] = plans.map((p) => p.layer);

      // Per-layer fan-out. A single layer's failure must NOT propagate —
      // surface the error to stderr (callers tail daemon logs anyway) and
      // continue with the surviving layers. Mirrors the partial-success
      // semantics in `DkgMemoryPlugin.ts:336-352`.
      const settled = await Promise.all(
        plans.map((plan) =>
          client
            .query({
              sparql,
              contextGraphId: plan.contextGraphId,
              view: plan.view,
              agentAddress,
            })
            .then((r) => ({ plan, bindings: r.bindings ?? [] }))
            .catch((err) => {
              process.stderr.write(
                `[dkg-mcp] memory-search ${plan.layer} failed (cg=${plan.contextGraphId}, view=${plan.view}): ${formatError(err)}\n`,
              );
              return { plan, bindings: [] as Array<Record<string, unknown>> };
            }),
        ),
      );

      // Dedup by (contextGraphId, uri-or-text-hash). Keep the highest-
      // trust hit; tie-break on raw score. Source: `DkgMemoryPlugin.ts:381-433`.
      interface RankedHit extends Hit {
        rank: number;
      }
      const best = new Map<string, RankedHit>();
      for (const { plan, bindings } of settled) {
        for (const binding of bindings) {
          // SparqlBinding fields can arrive as `{ value }` objects or flat
          // strings; `bindingValue` normalises both shapes (already in
          // `packages/mcp-dkg/src/sparql.ts`).
          const text = bindingValue((binding as Record<string, unknown>).text as never);
          const uri = bindingValue((binding as Record<string, unknown>).uri as never);
          if (!text) continue;
          const rawScore = computeKeywordOverlap(text, keywords);
          if (rawScore <= 0) continue;
          const weight = TRUST_WEIGHT[plan.layer];
          const weighted = rawScore * weight;
          const key = `${plan.contextGraphId}::${uri || hashString(text)}`;
          // Synthetic `path` mirrors the adapter shape
          // `dkg://${cg}/${layer}/${hash}` (`DkgMemoryPlugin.ts:410`)
          // so tooling that consumes either surface can dedup or
          // jump-to-source on the same identifier.
          const path = `dkg://${plan.contextGraphId}/${plan.layer}/${hashString(uri || text)}`;
          const candidate: RankedHit = {
            contextGraphId: plan.contextGraphId,
            layer: plan.layer,
            trustWeight: weight,
            score: rawScore,
            entityUri: uri,
            snippet: truncate(text, 500),
            path,
            rank: weighted,
          };
          const existing = best.get(key);
          if (!existing) {
            best.set(key, candidate);
            continue;
          }
          const existingTrust = TRUST_ORDER[existing.layer];
          const candidateTrust = TRUST_ORDER[candidate.layer];
          if (
            candidateTrust > existingTrust ||
            (candidateTrust === existingTrust && candidate.score > existing.score)
          ) {
            best.set(key, candidate);
          }
        }
      }

      const ranked = Array.from(best.values()).sort((a, b) => b.rank - a.rank);
      const top: Hit[] = ranked.slice(0, cap).map(({ rank: _rank, ...rest }) => rest);

      const totalRaw = settled.reduce((n, s) => n + s.bindings.length, 0);
      const breakdown = settled.map((s) => `${s.plan.layer}:${s.bindings.length}`).join(', ');

      // Info-level observability log per `dkg_memory_search` invocation.
      // Mirrors `packages/adapter-openclaw/src/DkgMemoryPlugin.ts:370-379` —
      // during the 2026-04-15 live validation this line was the
      // difference between "slot never called" and "slot called but no
      // hits". Counts and metadata only — the user query is omitted
      // because it can carry secrets/PII (the adapter logs it at debug
      // level only; mcp-dkg has no log-level surface, so we drop it).
      process.stderr.write(
        `[dkg-mcp] memory-search fired ` +
          `(limit=${cap}): project=${projectId ?? '∅'}, ` +
          `layers=${plans.length}, raw_hits=${totalRaw} (${breakdown})\n`,
      );
      const header =
        `Memory search "${trimmed}" — ${top.length} hit(s) (${totalRaw} raw across ${plans.length} layers).\n` +
        `searchedLayers: ${searchedLayers.join(', ')}\n` +
        `breakdown: ${breakdown}`;

      if (top.length === 0) return ok(header);

      // Per-hit text rendering surfaces provenance up-front:
      //   [agent-context · VM · weight=1.30 · score=0.87] <snippet>
      // The combined `Hit.layer` (SKILL §6.3 contract) decomposes into
      // the explicit `Hit.contextGraphId` (rendered as-is, lower-case
      // canonical) plus the trust tier (rendered upper-case via
      // `tierFromCombinedLayer`). Numeric weight + score show two
      // decimal places — enough precision to spot the trust-tiering
      // effect without flooding the line.
      const lines = top.map((h, i) => {
        const tier = tierFromCombinedLayer(h.layer);
        const provenance = `${h.contextGraphId} · ${tier} · weight=${h.trustWeight.toFixed(2)} · score=${h.score.toFixed(2)}`;
        const uriLine = h.entityUri ? `\`${h.entityUri}\`\n` : '';
        return `### ${i + 1}. [${provenance}]\n${uriLine}${h.snippet}`;
      });
      return ok(`${header}\n\n${lines.join('\n\n')}`);
    },
  );
}
