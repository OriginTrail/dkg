/**
 * Manifest templates with {{placeholder}} substitution.
 *
 * The cursor-rule and AGENTS.md templates are intentionally NOT here
 * — those are sourced from the canonical files in the repo at
 * publish time (`.cursor/rules/dkg-annotate.mdc` and `AGENTS.md`)
 * so they stay in lockstep with what we actually ship locally.
 *
 * The hook templates and config template ARE here because they're
 * authored solely for distribution (not used as files in the repo
 * itself — the repo's `.cursor/hooks.json` is hand-edited per
 * machine; the manifest distributes a parameterised version).
 *
 * Substitutable placeholders (see schema.ts MANIFEST_PLACEHOLDERS):
 *   {{agentUri}}            urn:dkg:agent:<lowercase-wallet-address> — cryptographic identity
 *   {{agentNickname}}       human-readable label, e.g. "Brana laptop 1"
 *   {{agentAddress}}        raw lowercase wallet address (0x-prefixed)
 *   {{agentSlug}}           BACK-COMPAT alias for nickname (slug-shaped)
 *   {{contextGraphId}}      CG id
 *   {{daemonApiUrl}}        local daemon API URL
 *   {{daemonTokenFile}}     relative path to auth.token
 *   {{workspaceAbsPath}}    absolute workspace path
 *   {{mcpDkgDistAbsPath}}   absolute path to packages/mcp-dkg/dist/index.js (LEGACY)
 *   {{mcpDkgPackageDir}}    absolute path to packages/mcp-dkg (for `pnpm --dir`)
 *   {{mcpDkgSrcAbsPath}}    absolute path to packages/mcp-dkg/src/index.ts
 *   {{captureScriptPath}}   absolute path to packages/mcp-dkg/hooks/capture-chat.mjs
 *   {{network}}             testnet / mainnet / devnet
 */

/**
 * `<workspace>/.cursor/hooks.json` — wires capture-chat.mjs to all
 * four Cursor session events with the right env vars baked in.
 *
 * Every placeholder that lands inside a shell command line uses the
 * `{{sh:...}}` form so `substitutePlaceholders` POSIX-shell-quotes the
 * value. Unquoted interpolation would let a path containing `$(...)`,
 * backticks, or a space inject arbitrary commands into the hook that
 * runs on every Cursor event.
 */
export const CURSOR_HOOKS_TEMPLATE = JSON.stringify(
  {
    _comment:
      'Workspace-scoped Cursor hooks for the DKG capture-chat integration. ' +
      'Generated from a project manifest by `dkg-mcp join`. ' +
      'DKG_WORKSPACE pins the hook to this workspace; DKG_API/DKG_AGENT_URI/DKG_TOKEN ' +
      'override what the script would otherwise read from .dkg/config.yaml. ' +
      "All hooks are failClosed:false — the script never blocks the user's chat.",
    version: 1,
    hooks: {
      sessionStart: [
        {
          command:
            'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_API={{sh:daemonApiUrl}} DKG_AGENT_URI={{sh:agentUri}} ' +
            'node {{sh:captureScriptPath}} sessionStart',
          failClosed: false,
        },
      ],
      sessionEnd: [
        {
          command:
            'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_API={{sh:daemonApiUrl}} DKG_AGENT_URI={{sh:agentUri}} ' +
            'node {{sh:captureScriptPath}} sessionEnd',
          failClosed: false,
        },
      ],
      beforeSubmitPrompt: [
        {
          command:
            'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_API={{sh:daemonApiUrl}} DKG_AGENT_URI={{sh:agentUri}} ' +
            'node {{sh:captureScriptPath}} beforeSubmitPrompt',
          failClosed: false,
        },
      ],
      afterAgentResponse: [
        {
          command:
            'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_API={{sh:daemonApiUrl}} DKG_AGENT_URI={{sh:agentUri}} ' +
            'node {{sh:captureScriptPath}} afterAgentResponse',
          failClosed: false,
        },
      ],
    },
  },
  null,
  2,
);

/**
 * `~/.claude/settings.json` HOOKS BLOCK — installer merges this into
 * the operator's existing settings.json (preserves their permissions
 * and other config). DKG_CAPTURE_TOOL=claude-code makes turns chip
 * correctly in the UI.
 */
export const CLAUDE_HOOKS_TEMPLATE = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_CAPTURE_TOOL=claude-code DKG_API={{sh:daemonApiUrl}} ' +
                'DKG_AGENT_URI={{sh:agentUri}} node {{sh:captureScriptPath}} SessionStart',
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_CAPTURE_TOOL=claude-code DKG_API={{sh:daemonApiUrl}} ' +
                'DKG_AGENT_URI={{sh:agentUri}} node {{sh:captureScriptPath}} UserPromptSubmit',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_CAPTURE_TOOL=claude-code DKG_API={{sh:daemonApiUrl}} ' +
                'DKG_AGENT_URI={{sh:agentUri}} node {{sh:captureScriptPath}} Stop',
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'DKG_WORKSPACE={{sh:workspaceAbsPath}} DKG_CAPTURE_TOOL=claude-code DKG_API={{sh:daemonApiUrl}} ' +
                'DKG_AGENT_URI={{sh:agentUri}} node {{sh:captureScriptPath}} SessionEnd',
            },
          ],
        },
      ],
    },
  },
  null,
  2,
);

/**
 * `<workspace>/.dkg/config.yaml` — the daemon binding config the MCP
 * server reads. The cursor MCP config inherits from this via the env
 * vars in the hooks; same for claude-code.
 */
export const CONFIG_YAML_TEMPLATE = `# .dkg/config.yaml — generated by \`dkg-mcp join\` for project {{contextGraphId}}
# on the {{network}} network. Edit by hand if you want to override
# anything; this file is gitignored.

contextGraph: {{contextGraphId}}
autoShare: true

node:
  api: {{daemonApiUrl}}
  tokenFile: {{daemonTokenFile}}

agent:
  # Cryptographic identity — derived from this machine's wallet address.
  # Same agent (you on this machine) across every project => the same uri.
  uri: {{agentUri}}
  # Human-readable label rendered in UIs / tools. Free-form, not used as
  # a URI fragment.
  nickname: {{agentNickname}}

capture:
  subGraph: chat
  assertion: chat-log
  privacy: team
  # NOTE: \`tool\` is intentionally NOT pinned here. Each tool's hook
  # script exports \`DKG_CAPTURE_TOOL\` at invocation time (Claude Code
  # hooks export \`claude-code\`, Cursor defaults to \`cursor\` when the
  # env var is absent), so the hook loader can tell which tool just
  # fired even on "both Cursor and Claude installed" setups. Writing
  # \`tool: cursor\` into this shared YAML used to break that because
  # \`.dkg/config.yaml\` beats \`DKG_CAPTURE_TOOL\` in the config loader
  # (see mcp-dkg/src/config.ts) — Claude-only installs would then
  # record every turn as \`cursor\`.
`;

/**
 * `<workspace>/.cursor/mcp.json` — wires the dkg MCP server into
 * Cursor with the right env vars. Installer merges with any existing
 * mcpServers block.
 *
 * We spawn `node <dist>` rather than `pnpm exec tsx <src>` because
 * this template gets installed into arbitrary workspaces — including
 * ones that npm-installed `@origintrail-official/dkg-mcp` from the
 * registry. The published tarball only ships `dist/` (+ hooks,
 * templates, etc.), NOT `src/`, and it isn't guaranteed to be a pnpm
 * workspace with `tsx` available. Pointing at `dist/index.js` makes
 * the generated wiring work both from a monorepo checkout (where the
 * installer built `dist/` before emitting the plan) and from a plain
 * npm install. The monorepo's own checked-in `.cursor/mcp.json` keeps
 * using `pnpm exec tsx src/index.ts` because `dist/` is gitignored
 * there and contributors shouldn't need a prior build just to boot
 * Cursor.
 */
export const CURSOR_MCP_JSON_TEMPLATE = JSON.stringify(
  {
    _comment:
      'Cursor MCP wiring for the DKG project {{contextGraphId}} on the ' +
      '{{network}} network. Generated by `dkg-mcp join`. Spawns the ' +
      'pre-built `@origintrail-official/dkg-mcp` entry point via `node` so ' +
      'it works from both monorepo checkouts and plain npm installs. Env ' +
      'vars override what the server would otherwise read from ' +
      '.dkg/config.yaml.',
    mcpServers: {
      dkg: {
        command: 'node',
        args: ['{{mcpDkgDistAbsPath}}'],
        // Cursor spawns MCP servers from its own CWD (not the workspace),
        // so the dkg MCP can't walk up to find .dkg/config.yaml on its
        // own. Pin cwd to the workspace root so loadConfig() picks up
        // the generated config (and, via it, the auth token file).
        cwd: '{{workspaceAbsPath}}',
        env: {
          DKG_API: '{{daemonApiUrl}}',
          DKG_PROJECT: '{{contextGraphId}}',
          DKG_AGENT_URI: '{{agentUri}}',
          DKG_AGENT_NICKNAME: '{{agentNickname}}',
        },
      },
    },
  },
  null,
  2,
);
