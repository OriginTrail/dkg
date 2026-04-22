#!/usr/bin/env node
// End-to-end smoke test for the new {{json:name}} placeholder form.
// Fetches a real manifest from a running devnet node, runs planInstall
// with a gnarly free-form nickname, writes it to a tmp workspace, and
// re-parses the installed .cursor/mcp.json + .dkg/config.yaml to
// prove nothing breaks the generated configs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planInstall, writeInstall } from '../packages/mcp-dkg/dist/manifest/install.js';
import { assembleStandardTemplates } from '../packages/mcp-dkg/dist/manifest/publish.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Reach into mcp-dkg's own node_modules since yaml is its transitive dep.
const { parse: parseYaml } = require(path.resolve('packages/mcp-dkg/node_modules/yaml'));

// Build a synthetic manifest from the LOCAL template constants (the
// thing we want to verify). This avoids depending on what happens to
// be published in devnet SWM — we care about what the installer WILL
// write when the NEW templates ship. A separate devnet-roundtrip test
// is already covered by scripts/devnet-test-invite-flow.sh.
const CG = 'devnet-test';
const templates = assembleStandardTemplates(path.resolve('.'));
const manifest = {
  uri: `urn:dkg:project:${CG}:manifest`,
  contextGraphId: CG,
  network: 'devnet',
  supportedTools: ['cursor', 'claude-code'],
  cursorRule:          { uri: `${CG}:cursorRule`,          ...templates.cursorRule },
  cursorHooksTemplate: { uri: `${CG}:cursorHooksTemplate`, ...templates.cursorHooksTemplate },
  claudeHooksTemplate: { uri: `${CG}:claudeHooksTemplate`, ...templates.claudeHooksTemplate },
  configTemplate:      { uri: `${CG}:configTemplate`,      ...templates.configTemplate },
  agentsMd:            { uri: `${CG}:agentsMd`,            ...templates.agentsMd },
  cursorMcpJson:       { uri: `${CG}:cursorMcpJson`,       ...templates.cursorMcpJson },
};
console.log(`[ok] assembled synthetic manifest for ${manifest.contextGraphId}`);

const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-n6-'));
console.log(`[ok] tmp workspace: ${tmpWs}`);

// Nickname that would have broken both JSON and YAML parsers under raw
// substitution: contains double-quote, backslash, colon, hash, newline,
// and emoji. All of these are legal UTF-8 and the `free-form` contract
// in MANIFEST_PLACEHOLDERS promises we accept them.
const nastyNickname = 'Brana\'s "laptop" #2:\nweird \\chars \u{1F4A9}';

const ctx = {
  manifest,
  workspaceAbsPath: tmpWs,
  homedir: path.join(tmpWs, 'fake-home'),
  agentSlug: 'brana-n6-test',
  agentNickname: nastyNickname,
  agentUri: 'urn:dkg:agent:0x1234567890abcdef1234567890abcdef12345678',
  agentAddress: '0x1234567890abcdef1234567890abcdef12345678',
  daemonApiUrl: 'http://127.0.0.1:9201',
  daemonTokenFile: '../../../.devnet/node1/auth.token',
  mcpDkgDistAbsPath: path.resolve('packages/mcp-dkg/dist/index.js'),
  mcpDkgPackageDir: path.resolve('packages/mcp-dkg'),
  mcpDkgSrcAbsPath: path.resolve('packages/mcp-dkg/src/index.ts'),
  captureScriptPath: path.resolve('packages/mcp-dkg/hooks/capture-chat.mjs'),
};

const plan = planInstall(ctx);
if (plan.warnings?.length) console.log('warnings:', plan.warnings);
await writeInstall(plan, ctx);
console.log('[ok] wrote install plan');

const mcpPath = path.join(tmpWs, '.cursor/mcp.json');
const yamlPath = path.join(tmpWs, '.dkg/config.yaml');

const mcpText = fs.readFileSync(mcpPath, 'utf-8');
const mcpJson = JSON.parse(mcpText);
const gotNickname = mcpJson.mcpServers.dkg.env.DKG_AGENT_NICKNAME;
if (gotNickname !== nastyNickname) {
  console.error('FAIL — mcp.json nickname mismatch');
  console.error('  expected:', JSON.stringify(nastyNickname));
  console.error('  got:     ', JSON.stringify(gotNickname));
  process.exit(1);
}
console.log('[ok] .cursor/mcp.json parsed — nickname preserved verbatim');

const yamlText = fs.readFileSync(yamlPath, 'utf-8');
const yamlDoc = parseYaml(yamlText);
if (yamlDoc.agent.nickname !== nastyNickname) {
  console.error('FAIL — config.yaml nickname mismatch');
  console.error('  expected:', JSON.stringify(nastyNickname));
  console.error('  got:     ', JSON.stringify(yamlDoc.agent.nickname));
  process.exit(1);
}
console.log('[ok] .dkg/config.yaml parsed — nickname preserved verbatim');

console.log(`\nALL GREEN — free-form nickname survives both generated configs.`);
fs.rmSync(tmpWs, { recursive: true, force: true });
