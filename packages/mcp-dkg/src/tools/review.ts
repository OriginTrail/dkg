/**
 * Phase 8 — review tool. The agent-side counterpart to the CLI's
 * interactive preview.
 *
 * `dkg_review_manifest` fetches a project's `dkg:ProjectManifest`
 * and returns a structured markdown summary so the agent (or a
 * separate trust-eval agent) can assess what an installer would
 * write before the operator confirms. Read-only — does not write
 * anything to disk OR to the graph.
 *
 * Pairs with the CLI `dkg-mcp join` flow: when the modal/CLI is
 * about to install a manifest, it can either show the review to the
 * human directly, OR ask the agent to assess via this tool first.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';
import { fetchManifest } from '../manifest/fetch.js';
import { planInstall, buildReviewMarkdown } from '../manifest/install.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM doesn't have __dirname; compute it ourselves so the review can
// reference the right paths to the dist + hook script.
const HERE = path.dirname(fileURLToPath(import.meta.url));

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const errResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

function resolveProject(
  explicit: string | undefined,
  config: DkgConfig,
): string | null {
  return explicit ?? config.defaultProject ?? null;
}

const projectErr = (): ToolResult =>
  errResult(
    'No project specified. Either pass `projectId` to this tool, set `DKG_PROJECT` in the environment, or pin `contextGraph:` in `.dkg/config.yaml`.',
  );

export function registerReviewTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): void {
  server.registerTool(
    'dkg_review_manifest',
    {
      title: 'Review Project Manifest',
      description:
        'Fetch a project\'s `dkg:ProjectManifest` and return a structured ' +
        'review of what installing it would do. Read-only — does NOT write ' +
        'files. Use this to assess a manifest before invoking the installer ' +
        '(via the `dkg-mcp join` CLI or the JoinProjectModal). The review ' +
        'covers: which files would be created/overwritten/merged where, ' +
        'placeholder substitutions, dropped paths (security warnings), and ' +
        'the curator\'s attribution. Pair with `dkg_get_ontology` to also ' +
        'review the project\'s annotation conventions.',
      inputSchema: {
        projectId: z.string().optional().describe('contextGraphId; defaults to .dkg/config.yaml'),
        agentSlug: z.string().optional().describe('What the operator would install AS — drives `urn:dkg:agent:<slug>` URIs in the substitutions. Defaults to the agent slug from config.'),
        workspaceAbsPath: z.string().optional().describe('Where the manifest would install — defaults to current working directory of the MCP server.'),
        daemonApiUrl: z.string().optional().describe('Local daemon URL the new agent would talk to. Defaults to the URL the MCP server itself uses.'),
      },
    },
    async ({ projectId, agentSlug, workspaceAbsPath, daemonApiUrl }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectErr();

      try {
        const manifest = await fetchManifest({ client, contextGraphId: pid });

        // Reasonable preview defaults — operator can override at install time.
        const slug = agentSlug
          ?? config.agentUri?.replace(/^urn:dkg:agent:/, '')
          ?? 'preview-agent';
        const ws = workspaceAbsPath ?? process.cwd();
        const apiUrl = daemonApiUrl ?? config.api;

        const plan = planInstall({
          manifest,
          workspaceAbsPath: ws,
          agentSlug: slug,
          daemonApiUrl: apiUrl,
          daemonTokenFile: '../.devnet/node1/auth.token',
          mcpDkgDistAbsPath: path.resolve(HERE, '..', 'index.js'),
          mcpDkgPackageDir: path.resolve(HERE, '..', '..'),
          mcpDkgSrcAbsPath: path.resolve(HERE, '..', '..', 'src', 'index.ts'),
          captureScriptPath: path.resolve(HERE, '..', '..', 'hooks', 'capture-chat.mjs'),
          homedir: os.homedir(),
        });

        const md = buildReviewMarkdown(manifest, plan);
        return ok(md + '\n\n---\n\n_This is a preview only. Run the install with `dkg-mcp join <invite-code>` (CLI) or via JoinProjectModal (UI). The operator confirms before any file is written._');
      } catch (e) {
        return errResult(`Failed to review manifest: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
