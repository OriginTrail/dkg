/**
 * `dkg_answer` — ask a natural-language question and get a GROUNDED answer whose
 * every fact is backed by a verifiable citation (OT-RFC-55).
 *
 * Unlike `dkg_memory_search` (which returns ranked snippets) and
 * `dkg_get_entity_sources` (which needs a known entity URI), `dkg_answer` chains
 * question → grounded facts → citations end to end. Each citation is auditable
 * against the chain: V10 Merkle inclusion + on-chain root + optional EIP-712
 * author seal. The human-readable answer is accompanied by the complete daemon
 * result as MCP structured content, including proof and seal material.
 *
 * Thin wrapper over `DkgClient.answer()` → `POST /api/answer`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient, DragAnswerResult } from '../client.js';
import type { DkgConfig } from '../config.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (text: string, result: DragAnswerResult): ToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: result as unknown as Record<string, unknown>,
});
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const formatError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function resolveProject(explicit: string | undefined, config: DkgConfig): string | null {
  return explicit ?? config.defaultProject ?? null;
}

function summarize(r: DragAnswerResult): string {
  const { factsCited, verified } = r.stats;
  if (factsCited === 0) return r.answer;
  const trust =
    verified === factsCited
      ? `All ${factsCited} citation${factsCited === 1 ? '' : 's'} verified against the chain ✓`
      : `${verified}/${factsCited} citations verified against the chain`;
  const net =
    r.scope === 'network'
      ? ` · network: ${r.stats.nodesAnswered ?? 0}/${r.stats.servingNodes ?? 0} serving nodes` +
        (r.stats.scopeVerified === true ? ' · public scope verified' : ' · scope unverified') +
        ((r.stats.peersSkipped ?? 0) > 0 || (r.stats.notEvaluated ?? 0) > 0
          ? ` · partial (${r.stats.peersSkipped ?? 0} peers skipped, ${r.stats.notEvaluated ?? 0} citations not evaluated)`
          : '')
      : '';
  const paid = r.settlement?.ok
    ? ` · paid ${r.settlement.amount} ${r.settlement.asset} (x402)`
    : '';
  const retrieval = String(r.stats.retrieval ?? '');
  const groundedBy = r.llm
    ? 'LLM-synthesised from verified facts'
    : r.scope === 'network'
      ? 'network-grounded'
      : retrieval.startsWith('vector:')
        ? 'semantic-grounded'
        : 'keyword-grounded';
  const header = `> ${trust} · context graph \`${r.contextGraphId}\` · ${groundedBy}${net}${paid}\n`;
  return `${header}\n${r.answer}`;
}

export function registerAnswerTool(server: McpServer, client: DkgClient, config: DkgConfig): void {
  server.registerTool(
    'dkg_answer',
    {
      title: 'Answer (grounded + verifiable citations)',
      description:
        'Ask a natural-language question about a context graph and get a grounded ' +
        'answer where every fact carries a VERIFIABLE citation (V10 Merkle ' +
        'inclusion + on-chain anchor, with an author seal when available). Use this when you need ' +
        'an answer you can AUDIT — each cited fact is bound to a sealed, on-chain ' +
        'Knowledge Asset, so a fabricated or tampered citation fails verification. ' +
        'The tool returns a concise text answer plus structured facts, full Merkle ' +
        'proofs, optional author seals, verification checks, and per-node diagnostics. ' +
        'Local retrieval can be keyword or semantic; network responders use a bounded ' +
        'keyword path. No LLM is required. For ranked snippet recall use ' +
        '`dkg_memory_search`; for the sources of a KNOWN entity use ' +
        '`dkg_get_entity_sources`.',
      inputSchema: {
        question: z.string().trim().min(1).max(2_000).describe('The natural-language question to answer (max 2,000 characters).'),
        projectId: z
          .string()
          .optional()
          .describe('Context graph to answer over. Defaults to the pinned project.'),
        scope: z
          .enum(['local', 'network'])
          .optional()
          .describe(
            'Where to answer from. "local" (default) = this node\'s copy of the ' +
              'context graph. "network" = fan out to a bounded set of nodes serving the (public) ' +
              'context graph and aggregate their citations, each re-verified against ' +
              'the chain — use it to answer over knowledge this node may not hold.',
          ),
        retrieval: z
          .enum(['default', 'keyword', 'semantic'])
          .optional()
          .describe(
            'How to find relevant facts (applies to scope:"local"; network responders use bounded ' +
              'keyword retrieval). "default" = the node\'s configured ' +
              'retrieval. "keyword" = substring-select matching entities, then return their bounded ' +
              'entity facts (predictable, but misses paraphrases). ' +
              '"semantic" = embedding search that matches by MEANING (finds facts that never use ' +
              "the question's words) — requires the node to have an embedding model configured/installed.",
          ),
        maxCitations: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Cap on cited facts (default 12).'),
      },
    },
    async ({ question, projectId, scope, retrieval, maxCitations }): Promise<ToolResult> => {
      const cg = resolveProject(projectId, config);
      if (!cg) {
        return err(
          'No context graph specified. Pass `projectId`, set `DKG_PROJECT`, or pin `contextGraph:` in `.dkg/config.yaml`.',
        );
      }
      try {
        // Network responders intentionally force bounded keyword retrieval. Do
        // not forward a local-only retrieval mode that the daemon must reject.
        const result = await client.answer({
          question,
          contextGraphId: cg,
          scope,
          retrieval: scope === 'network' ? undefined : retrieval,
          maxCitations,
        });
        return ok(summarize(result), result);
      } catch (e) {
        return err(`dkg_answer failed: ${formatError(e)}`);
      }
    },
  );
}
