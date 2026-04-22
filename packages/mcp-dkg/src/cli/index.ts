/**
 * `dkg-mcp` CLI — operator-facing onboarding commands.
 *
 * Co-resident with the MCP server in the same `dkg-mcp` binary. The
 * dispatcher in `index.ts` routes argv[2] to either CLI subcommand
 * or stdio MCP server.
 *
 * Subcommands (Phase 8 day 2):
 *   join <invite-code> [opts]   Subscribe to a project + install workspace files
 *   status                      Show current install + project membership state
 *   help                        Print usage
 *
 * Subcommands coming in day 3:
 *   sync                        Diff local install vs project's current manifest
 *   create-project              Curator-side: create CG + publish manifest
 *
 * Distribution:
 *   - Today:  `pnpm exec dkg-mcp join <invite>` (after `pnpm install` + `pnpm build`)
 *   - Or:     `node packages/mcp-dkg/dist/index.js join <invite>`
 *   - Future: `npx @origintrail-official/dkg-mcp join <invite>` once the package
 *             is published to npm.
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { loadConfig } from '../config.js';
import { DkgClient, DkgHttpError } from '../client.js';
import { fetchManifest } from '../manifest/fetch.js';
import { planInstall, writeInstall, buildReviewMarkdown } from '../manifest/install.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_SUBCOMMANDS = new Set(['join', 'status', 'help', '--help', '-h']);

export function isKnownCliSubcommand(s: string): boolean {
  return KNOWN_SUBCOMMANDS.has(s);
}

export async function runCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case 'join':
      return cmdJoin(argv.slice(1));
    case 'status':
      return cmdStatus(argv.slice(1));
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return 0;
    default:
      console.error(`unknown subcommand: ${sub}`);
      printUsage();
      return 1;
  }
}

function printUsage(): void {
  process.stdout.write(`dkg-mcp — DKG project onboarding CLI

USAGE
  dkg-mcp join <invite-code>  [options]
  dkg-mcp status              [--project=<id>]
  dkg-mcp help

COMMANDS
  join     Subscribe to a project on the DKG and install its workspace
           files (Cursor MCP wiring, hooks, rule, AGENTS.md, .dkg/config.yaml,
           Claude Code settings) per the project's published manifest.

  status   Show the current install state of this workspace + which DKG
           projects this node is subscribed to.

JOIN OPTIONS
  --workspace=<path>       Workspace to install into (default: cwd)
  --agent-slug=<slug>      Your agent slug for this machine
                           (e.g. branarakic-laptop2). Will be prompted if
                           not provided.
  --daemon=<url>           Local daemon URL (default: http://localhost:9201,
                           or DKG_API env var)
  --token=<token>          Daemon auth token (default: DKG_TOKEN env)
  --token-file=<rel-path>  Path to auth.token, relative to .dkg/config.yaml
                           (default: ../.devnet/node1/auth.token)
  --yes                    Skip the confirmation prompt
  --dry-run                Print the install plan but don't write anything
  --no-subscribe           Skip the subscribe step (manifest already locally
                           available; useful for re-running install)
  --skip-claude            Don't touch ~/.claude/settings.json (use this if you
                           manage Claude Code wiring per-project some other way,
                           or just want to test without affecting your real
                           Claude Code config)

INVITE CODE FORMAT
  Either:
    just-the-context-graph-id
    "<contextGraphId> @ <multiaddr>"

EXAMPLES
  dkg-mcp join dkg-code-project
  dkg-mcp join "did:dkg:context-graph:my-project @ /dns4/relay.../p2p/Qm..." \\
    --workspace=$HOME/dev/myproject \\
    --agent-slug=alice-laptop1
`);
}

// ── join ───────────────────────────────────────────────────────────

interface JoinOptions {
  workspace: string;
  agentSlug?: string;
  daemonUrl: string;
  token?: string;
  tokenFile: string;
  yes: boolean;
  dryRun: boolean;
  noSubscribe: boolean;
  skipClaude: boolean;
  inviteCode: string;
}

function parseJoinArgs(args: string[]): JoinOptions {
  const { values, positionals } = parseArgs({
    args,
    options: {
      workspace:    { type: 'string' },
      'agent-slug': { type: 'string' },
      daemon:       { type: 'string' },
      token:        { type: 'string' },
      'token-file': { type: 'string' },
      yes:          { type: 'boolean', default: false },
      'dry-run':    { type: 'boolean', default: false },
      'no-subscribe': { type: 'boolean', default: false },
      'skip-claude': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length < 1) {
    throw new Error('join: missing invite code (positional arg). Run `dkg-mcp help` for usage.');
  }
  return {
    inviteCode: positionals.join(' '),
    workspace: path.resolve(values.workspace ?? process.cwd()),
    agentSlug: values['agent-slug'],
    daemonUrl: values.daemon ?? process.env.DKG_API ?? 'http://localhost:9201',
    token: values.token ?? process.env.DKG_TOKEN ?? process.env.DEVNET_TOKEN,
    // Default to the daemon's canonical token location
    // (`~/.dkg/auth.token`) — the one that `dkgd` itself writes. The old
    // `../.devnet/node1/auth.token` default only made sense when joining
    // from inside the monorepo's devnet setup; a normal `dkg-mcp join`
    // on a user workstation would generate a `.dkg/config.yaml` pointing
    // at a file that doesn't exist, so the first MCP/hook calls 401'd
    // until the user noticed and edited the YAML by hand.
    tokenFile: values['token-file'] ?? path.join(os.homedir(), '.dkg', 'auth.token'),
    yes: values.yes,
    dryRun: values['dry-run'],
    noSubscribe: values['no-subscribe'],
    skipClaude: values['skip-claude'],
  };
}

interface ParsedInvite {
  contextGraphId: string;
  multiaddr: string | null;
}

function parseInviteCode(raw: string): ParsedInvite {
  const trimmed = raw.trim();
  // Two formats accepted:
  //   "<cgId>"
  //   "<cgId> @ <multiaddr>"
  const m = trimmed.match(/^(.+?)\s*@\s*(\/.+)$/);
  if (m) return { contextGraphId: m[1].trim(), multiaddr: m[2].trim() };
  return { contextGraphId: trimmed, multiaddr: null };
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const ans = (await rl.question(`${question}${suffix}: `)).trim();
    return ans || defaultValue || '';
  } finally {
    rl.close();
  }
}

async function cmdJoin(args: string[]): Promise<number> {
  let opts: JoinOptions;
  try {
    opts = parseJoinArgs(args);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  const invite = parseInviteCode(opts.inviteCode);
  console.log(`[join] context graph: ${invite.contextGraphId}`);
  if (invite.multiaddr) console.log(`[join] curator multiaddr: ${invite.multiaddr}`);

  // ── 1. Sanity-check the daemon ──
  console.log(`[join] checking local daemon at ${opts.daemonUrl}...`);
  const config = loadConfig(opts.workspace);
  // Resolve the bearer token BEFORE the first daemon call so fresh
  // machines don't 401 on the very first `listProjects()`. Priority:
  //
  //   1. --token / DKG_TOKEN / DEVNET_TOKEN (explicit opts.token)
  //   2. existing .dkg/config.yaml (config.token from loadConfig)
  //   3. --token-file (explicit or default ~/.dkg/auth.token)
  //
  // Previously (3) was silently ignored here, so `dkg-mcp join` on a
  // first-run machine with only a daemon-written auth.token file would
  // send an empty Bearer, get 401 on /listProjects, and abort before
  // the generated config.yaml could even be written. loadConfig already
  // resolves `.dkg/config.yaml`'s tokenFile field, but that file doesn't
  // exist yet the first time you run `join` — so we also read the CLI
  // tokenFile ourselves.
  let resolvedToken = opts.token ?? config.token ?? null;
  if (!resolvedToken && opts.tokenFile) {
    try {
      const raw = fs.readFileSync(opts.tokenFile, 'utf-8');
      const lines = raw.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
      const candidate = lines.join('').trim();
      if (candidate) resolvedToken = candidate;
    } catch {
      // tokenFile doesn't exist / isn't readable yet — fall through and
      // let the daemon call 401 with a helpful error below. Don't fail
      // hard here because the user may legitimately have set a literal
      // --token or DKG_TOKEN that we already picked up.
    }
  }
  const effectiveConfig = {
    ...config,
    api: opts.daemonUrl,
    token: resolvedToken ?? '',
    defaultProject: invite.contextGraphId,
  };
  const client = new DkgClient({ config: effectiveConfig });

  let daemonAlive = false;
  try {
    await client.listProjects();
    daemonAlive = true;
  } catch (err) {
    if (err instanceof DkgHttpError && err.status === 401) {
      console.error(
        `[join] daemon at ${opts.daemonUrl} requires auth. Pass --token=<token>, ` +
        `or set DKG_TOKEN, or read it from your auth.token file. Run \`./scripts/devnet.sh status\` ` +
        `if you don't have a daemon running yet.`,
      );
      return 1;
    }
    console.error(
      `[join] no daemon reachable at ${opts.daemonUrl}: ${(err as Error).message}\n` +
      `Start one with \`./scripts/devnet.sh start\` (local devnet) or point at an existing daemon ` +
      `with --daemon=<url>.`,
    );
    return 1;
  }
  if (!daemonAlive) {
    console.error('[join] daemon not reachable; aborting.');
    return 1;
  }

  // ── 2. Subscribe (optional — skip with --no-subscribe if already subscribed) ──
  if (!opts.noSubscribe) {
    console.log(`[join] subscribing to ${invite.contextGraphId}...`);
    try {
      // Use the legacy /api/subscribe path; handler is the same as /api/context-graph/subscribe.
      // We call it directly via the client's internal request path; keeping this loose for now
      // since the manifest itself is the source of truth for what to install.
      await (client as any).request('POST', '/api/context-graph/subscribe', {
        contextGraphId: invite.contextGraphId,
        ...(invite.multiaddr ? { multiaddr: invite.multiaddr } : {}),
      });
      console.log('[join] subscribe call accepted; waiting for catchup...');
      // Short poll for catchup; the manifest may take a few seconds to land.
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      // Subscription may already exist or be auto-allowed; we don't fail
      // the install just because /subscribe complained — we'll find out
      // when we try to fetch the manifest.
      const msg = (err as Error).message;
      console.warn(`[join] subscribe call returned a warning (continuing): ${msg.slice(0, 200)}`);
    }
  }

  // ── 3. Fetch the manifest ──
  console.log(`[join] fetching project manifest...`);
  let manifest;
  try {
    manifest = await fetchManifest({ client, contextGraphId: invite.contextGraphId });
  } catch (err) {
    console.error(`[join] ${(err as Error).message}`);
    return 1;
  }
  console.log(`[join] manifest fetched: ${manifest.uri}`);
  console.log(`[join]   network: ${manifest.network} | tools: ${manifest.supportedTools.join(', ')}${manifest.publishedBy ? ` | published by: ${manifest.publishedBy}` : ''}`);

  // ── 4. Resolve agent slug ──
  let agentSlug = opts.agentSlug;
  if (!agentSlug && !opts.yes) {
    const guess = `${os.userInfo().username}-${os.hostname().split('.')[0]}`;
    agentSlug = await prompt('Your agent slug for this machine', guess);
  }
  if (!agentSlug) {
    console.error('[join] agent slug required; pass --agent-slug=<slug> or run interactively.');
    return 1;
  }

  // ── 4b. Resolve cryptographic agent URI ──
  //
  // The UI install path resolves `agentUri` from the daemon's bearer
  // token (DKGAgent.resolveAgentAddress) so every install by the same
  // operator binds to the SAME `urn:dkg:agent:<wallet>`. The CLI used
  // to fall through to the legacy `urn:dkg:agent:<slug>` form, which
  // meant the same person joining via CLI vs. UI showed up as two
  // different agents in the graph and broke attribution / search
  // convergence. Ask the daemon who we are and, if it returns a valid
  // `0x…` wallet address, pass that into the planner. Peer-ID
  // fallbacks (resolveAgentAddress returns the node peer ID when no
  // wallet is configured) are NOT valid agent URIs, so we keep the
  // slug fallback for those setups to preserve the old behaviour
  // rather than mint malformed `urn:dkg:agent:<peerId>` URIs.
  const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  let agentUri: string | undefined;
  let agentAddress: string | undefined;
  try {
    const identity = (await (client as any).request(
      'GET',
      '/api/agent/identity',
    )) as { agentAddress?: string } | undefined;
    const raw = identity?.agentAddress;
    if (raw && EVM_ADDRESS_RE.test(raw)) {
      agentAddress = raw.toLowerCase();
      agentUri = `urn:dkg:agent:${agentAddress}`;
      console.log(`[join] agent URI: ${agentUri}`);
    } else if (raw) {
      console.warn(
        `[join] daemon returned non-wallet agent identifier "${raw.slice(0, 24)}…"; ` +
          `falling back to slug-based URI. Configure a default wallet on the ` +
          `daemon (or use a token bound to an agent wallet) for wallet-based attribution.`,
      );
    }
  } catch (err) {
    console.warn(
      `[join] /api/agent/identity unavailable; falling back to slug-based URI. ` +
        `Wallet-based attribution will not be wired for this install. (${(err as Error).message.slice(0, 120)})`,
    );
  }

  // ── 5. Plan + show preview ──
  const ctx = {
    manifest,
    workspaceAbsPath: opts.workspace,
    agentSlug,
    ...(agentUri ? { agentUri } : {}),
    ...(agentAddress ? { agentAddress } : {}),
    daemonApiUrl: opts.daemonUrl,
    daemonTokenFile: opts.tokenFile,
    mcpDkgDistAbsPath: path.resolve(HERE, '..', 'index.js'),
    mcpDkgPackageDir: path.resolve(HERE, '..', '..'),
    mcpDkgSrcAbsPath: path.resolve(HERE, '..', '..', 'src', 'index.ts'),
    captureScriptPath: path.resolve(HERE, '..', '..', 'hooks', 'capture-chat.mjs'),
    homedir: os.homedir(),
  };
  const plan = planInstall(ctx);
  // --skip-claude removes the ~/.claude/settings.json target from the plan.
  // Useful for testing without polluting the operator's real Claude Code
  // wiring, and for operators who manage that file by other means.
  if (opts.skipClaude) {
    const before = plan.files.length;
    plan.files = plan.files.filter((f) => f.field !== 'claudeHooksTemplate');
    if (plan.files.length < before) {
      plan.warnings.push('--skip-claude set; ~/.claude/settings.json will not be touched.');
    }
  }
  // Safety guard: if ~/.claude/settings.json already has DKG hooks pointing
  // at a DIFFERENT workspace/agent, warn the operator before clobbering them.
  // (Common in dev: switching between two test workspaces silently breaks
  // the operator's main one without this check.)
  const claudeFile = plan.files.find((f) => f.field === 'claudeHooksTemplate');
  if (claudeFile && claudeFile.exists) {
    try {
      const existing = JSON.parse(fs.readFileSync(claudeFile.absPath, 'utf-8'));
      const existingHooks = JSON.stringify(existing?.hooks ?? {});
      const existingWs = existingHooks.match(/DKG_WORKSPACE=([^\s]+)/)?.[1];
      const existingAgent = existingHooks.match(/DKG_AGENT_URI=([^\s]+)/)?.[1];
      if (existingWs && existingWs !== opts.workspace) {
        plan.warnings.push(
          `~/.claude/settings.json currently has DKG hooks bound to workspace "${existingWs}" — installing into "${opts.workspace}" will REPLACE them. Use --skip-claude to keep your existing wiring, or this will silently break Claude Code in the other workspace.`,
        );
      }
      // Compare against the wallet-derived URI if available (matches
      // what planInstall will actually template in); otherwise fall
      // back to the slug-based form we used historically.
      const plannedAgentUri = agentUri ?? `urn:dkg:agent:${agentSlug}`;
      if (existingAgent && existingAgent !== plannedAgentUri) {
        plan.warnings.push(
          `~/.claude/settings.json currently has DKG hooks attributed to "${existingAgent}" — installing as "${plannedAgentUri}" will REPLACE that attribution.`,
        );
      }
    } catch {
      /* settings.json corrupt or unreadable; install will fail later anyway */
    }
  }
  const preview = buildReviewMarkdown(manifest, plan);
  console.log('\n' + preview + '\n');

  if (opts.dryRun) {
    console.log('[join] --dry-run set; not writing anything.');
    return 0;
  }

  // ── 6. Confirm + write ──
  if (!opts.yes) {
    const yes = await prompt(`\nApply ${plan.files.length} file write${plan.files.length === 1 ? '' : 's'}? (y/n)`, 'y');
    if (yes.toLowerCase() !== 'y') {
      console.log('[join] aborted by operator.');
      return 0;
    }
  }
  console.log('[join] writing files...');
  let results;
  try {
    results = await writeInstall(plan);
  } catch (err) {
    console.error(`[join] write failed: ${(err as Error).message}`);
    return 1;
  }
  for (const r of results) {
    console.log(`[join]   ${r.action.padEnd(10)} ${r.absPath} (${r.bytesWritten.toLocaleString()} bytes)`);
  }

  console.log(`\n[join] ✔ Installed ${results.length} file${results.length === 1 ? '' : 's'} for project ${invite.contextGraphId}.`);
  console.log(`[join]   agent URI: urn:dkg:agent:${agentSlug}`);
  console.log(`[join]   workspace: ${opts.workspace}`);
  console.log(`[join]   next: open Cursor in ${opts.workspace} — your agent is wired and will start capturing turns.`);
  return 0;
}

// ── status ─────────────────────────────────────────────────────────

async function cmdStatus(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      daemon:  { type: 'string' },
      token:   { type: 'string' },
    },
  });
  const daemonUrl = values.daemon ?? process.env.DKG_API ?? 'http://localhost:9201';
  const token = values.token ?? process.env.DKG_TOKEN ?? process.env.DEVNET_TOKEN ?? '';
  const config = loadConfig();
  const client = new DkgClient({
    config: { ...config, api: daemonUrl, token: token || config.token },
  });

  console.log(`Daemon:    ${daemonUrl}`);
  let projects;
  try {
    projects = await client.listProjects();
  } catch (err) {
    console.error(`  ✘ unreachable: ${(err as Error).message}`);
    return 1;
  }
  console.log(`  ✔ reachable, ${projects.length} project(s) known\n`);

  console.log('Projects:');
  for (const p of projects) {
    const pinned = config.defaultProject === p.id ? ' ★' : '';
    console.log(`  - ${p.id}${pinned}   ${p.name ?? ''}`);
  }

  console.log('\nWorkspace install state (cwd):');
  const cwd = process.cwd();
  const checks = [
    ['.cursor/mcp.json',                     path.join(cwd, '.cursor', 'mcp.json')],
    ['.cursor/hooks.json',                   path.join(cwd, '.cursor', 'hooks.json')],
    ['.cursor/rules/dkg-annotate.mdc',       path.join(cwd, '.cursor', 'rules', 'dkg-annotate.mdc')],
    ['.dkg/config.yaml',                     path.join(cwd, '.dkg', 'config.yaml')],
    ['AGENTS.md',                            path.join(cwd, 'AGENTS.md')],
  ];
  for (const [label, p] of checks) {
    const exists = fs.existsSync(p);
    console.log(`  ${exists ? '✔' : '✘'} ${label}`);
  }

  return 0;
}
