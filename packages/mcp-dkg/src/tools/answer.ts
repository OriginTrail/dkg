/**
 * `dkg_answer` — ask a natural-language question and get a GROUNDED answer whose
 * every fact is backed by a verifiable citation (OT-RFC-55 P2, single-node).
 *
 * Unlike `dkg_memory_search` (which returns ranked snippets) and
 * `dkg_get_entity_sources` (which needs a known entity URI), `dkg_answer` chains
 * question → grounded facts → citations end to end. Each citation is auditable
 * against the chain: V10 Merkle inclusion + on-chain root + EIP-712 author seal.
 * Retrieval is keyword/structural — no node-side LLM required.
 *
 * Thin wrapper over `DkgClient.answer()` → `POST /api/answer`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient, DragAnswerResult } from '../client.js';
import type { DkgConfig } from '../config.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
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
  const header = `> ${trust} · context graph \`${r.contextGraphId}\`${r.llm ? ' · LLM-synthesised' : ' · keyword-grounded'}\n`;
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
        'inclusion + on-chain anchor + EIP-712 author seal). Use this when you need ' +
        'an answer you can AUDIT — each cited fact is bound to a sealed, on-chain ' +
        'Knowledge Asset, so a fabricated or tampered citation fails verification. ' +
        'Retrieval is keyword-based over the verifiable memory of one context graph ' +
        'on this node (no LLM required). For ranked snippet recall use ' +
        '`dkg_memory_search`; for the sources of a KNOWN entity use ' +
        '`dkg_get_entity_sources`.',
      inputSchema: {
        question: z.string().min(1).describe('The natural-language question to answer.'),
        projectId: z
          .string()
          .optional()
          .describe('Context graph to answer over. Defaults to the pinned project.'),
        maxCitations: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Cap on cited facts (default 12).'),
      },
    },
    async ({ question, projectId, maxCitations }): Promise<ToolResult> => {
      const cg = resolveProject(projectId, config);
      if (!cg) {
        return err(
          'No context graph specified. Pass `projectId`, set `DKG_PROJECT`, or pin `contextGraph:` in `.dkg/config.yaml`.',
        );
      }
      try {
        const result = await client.answer({ question, contextGraphId: cg, maxCitations });
        return ok(summarize(result));
      } catch (e) {
        return err(`dkg_answer failed: ${formatError(e)}`);
      }
    },
  );
}
