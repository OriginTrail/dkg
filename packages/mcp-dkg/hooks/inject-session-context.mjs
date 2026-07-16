#!/usr/bin/env node
/**
 * inject-session-context.mjs
 *
 * Cursor `beforeSubmitPrompt` + Claude Code `UserPromptSubmit` hook
 * that prepends a `<dkg-session-context>` block to every prompt so
 * the agent can author structured annotations (Decision / Finding /
 * Task / Question / code-ref) carrying a proper graph edge back to
 * the `chat:Turn` capture-chat.mjs will write after the response.
 *
 * Why this hook exists (the gap it closes)
 * ----------------------------------------
 * The V9 prompt-injection sub-system (`sessionStart` additionalContext
 * with "Your session ID: <id>") was retired in the V10 MCP consolidation
 * (#381) and the subsequent R3 capture-chat reduction (commit 0e7abdf9).
 * Without it, the agent has no reliable input carrying its own `conversation_id`,
 * so it cannot compute the predictable URI
 *
 *   urn:dkg:chat:session:<sessionKey>#turn:<idx>
 *
 * that capture-chat.mjs writes deterministically after the response.
 * Annotations written during the turn end up orphaned (no graph edge
 * back to the Turn that produced them). This hook restores that input
 * via the `updated_input` channel (the only V10-supported prompt
 * injection mechanism), so annotations can include edges like
 *
 *   <turn-uri> chat:proposes  <finding-uri>
 *   <turn-uri> chat:mentions  <file-uri>
 *
 * and the capture-chat write that lands after the response completes
 * the JOIN.
 *
 * Hook ordering (.cursor/hooks.json)
 * ----------------------------------
 *   1. capture-chat.mjs (beforeSubmitPrompt) — stashes the ORIGINAL
 *      prompt before any hook mutates it, and persists session state
 *      (turnIndex, pendingPrompt).
 *   2. inject-session-context.mjs (this hook) — reads the persisted
 *      state, computes next-turn index, prepends the block.
 *   3. inject-inbox.mjs — prepends inbox notice if unread peer
 *      messages exist. Sees prompt-with-session-context as its input
 *      and prepends ABOVE it, producing final order:
 *         <dkg-inbox-notice>      (most urgent)
 *         <dkg-session-context>   (administrative metadata)
 *         <operator prompt>       (the actual ask)
 *
 * Output contract
 * ---------------
 *   { updated_input: "<dkg-session-context>...\n\n<operator prompt>" }
 * or `{}` on any failure (fail-open per hook convention).
 *
 * Security model
 * --------------
 * Both injected fields come from the local trust boundary:
 *   - `sessionKey` is Cursor's `conversation_id` from the hook payload
 *     (a value Cursor itself mints; never peer-controlled).
 *   - `nextTurnIndex` comes from `~/.cache/dkg-mcp/sessions/<sessionKey>.json`,
 *     which only capture-chat.mjs writes on this machine.
 *   - `agentUri` is read from `.dkg/config.yaml` (local).
 *
 * No peer-controlled data is inlined. Same posture as inject-inbox.mjs,
 * which explicitly forbids peer text in the prompt; we route around
 * that constraint by injecting only locally-controlled identifiers.
 *
 * Design principles (mirror capture-chat.mjs / inject-inbox.mjs)
 * -------------------------------------------------------------
 *   1. FAIL OPEN. Any error → `{}` on stdout (no modification). The
 *      hook must never block the operator's prompt.
 *   2. FAIL CLOSED on prompt extraction. If we cannot identify the
 *      operator's prompt, we must NOT emit `updated_input` (would
 *      silently REPLACE the prompt with just our block).
 *   3. NO NEW CONFIG SURFACE. Reads `.dkg/config.yaml` walking
 *      upward from cwd for `agent.uri`.
 *   4. STDLIB ONLY. No npm imports.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Lockstep contract: reuse capture-chat's helpers verbatim so the
// two hooks recognise the SAME payload shapes, derive the SAME
// session keys, and predict / write the SAME turn URIs. Any drift
// here silently orphans annotations (capture-chat persists a turn
// the agent can't link back to, or vice versa). capture-chat
// already exports these for exactly this purpose; same-directory
// sibling import is safe (capture-chat's `main()` runs only under
// its own `isMainModule` guard, so importing it has no side
// effects). See Codex PR #589 finding 2.
import {
  extractText as captureExtractText,
  extractSessionKey as captureExtractSessionKey,
  sanitiseSlug as captureSanitiseSlug,
  pick as capturePick,
} from './capture-chat.mjs';

const LOG_FILE = process.env.DKG_SESSION_CTX_LOG ?? '/tmp/dkg-inject-session-context.log';
const STATE_DIR = path.join(os.homedir(), '.cache', 'dkg-mcp', 'sessions');

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* never crash the hook just because we can't log */
  }
}

// Re-export the capture-chat helpers under our own names so existing
// tests (and any future ones) that import `pick` / `sanitiseSlug` /
// `extractSessionKey` from this module continue to resolve. By
// re-exporting (rather than re-implementing) we get drift-proof
// lockstep with capture-chat by construction.
export const pick = capturePick;
export const sanitiseSlug = captureSanitiseSlug;
export const extractSessionKey = captureExtractSessionKey;

export function extractPrompt(payload) {
  if (!payload || typeof payload !== 'object') return '';
  // Defensive: an upstream beforeSubmitPrompt hook may have already
  // emitted `updated_input`. Cursor's docs don't specify how the
  // field composes across sequential hooks, but if it IS surfaced
  // to downstream hooks we want to treat it as the canonical prompt
  // rather than going back to the original `prompt` field — that
  // would silently overwrite any earlier prepended block. Mirrors
  // the matching guard in inject-inbox.mjs. See Codex PR #589
  // round 3 finding on hook composition.
  if (typeof payload.updated_input === 'string' && payload.updated_input.trim()) {
    return payload.updated_input;
  }
  // `readStdinJson` wraps non-JSON stdin in `{ rawPayload: <text> }`
  // so the operator's prompt is recoverable even when Cursor sends
  // a plain string. Honour that envelope before delegating to the
  // shared key-extraction helper.
  if (typeof payload.rawPayload === 'string' && payload.rawPayload.trim()) {
    return payload.rawPayload;
  }
  // Delegate to capture-chat's `extractText` so the user-prompt
  // candidate list (`prompt`, `userPrompt`, `user_prompt`, `request`,
  // `input`, …) stays in exact sync. Any future Cursor / Claude /
  // Aider payload-shape change captured there flows through here for
  // free, eliminating the orphan-annotation drift Codex flagged on
  // PR #589.
  return captureExtractText(payload);
}

function findWorkspaceConfig(start) {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.dkg', 'config.yaml');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Read the single `agent.uri` field from the workspace YAML. We deliberately
// don't reuse the full parsers from sibling hooks — they each carry their own
// stripped-down parser for the same reason: stdlib-only + small footprint.
export function parseAgentUri(yamlText) {
  const lines = yamlText.split('\n');
  let inAgent = false;
  let agentIndent = -1;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    if (!inAgent && /^agent\s*:\s*$/.test(line.trim())) {
      inAgent = true;
      agentIndent = indent;
      continue;
    }
    if (inAgent && indent <= agentIndent) {
      // dedented out of the `agent:` block before finding `uri`
      inAgent = false;
    }
    if (inAgent) {
      const m = line.trim().match(/^uri\s*:\s*(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  return null;
}

function loadAgentUri() {
  const fromEnv = process.env.DKG_AGENT_URI?.trim();
  if (fromEnv) return fromEnv;
  const cwd = process.env.DKG_WORKSPACE ?? process.cwd();
  const cfgPath = findWorkspaceConfig(cwd);
  if (!cfgPath) return null;
  try {
    return parseAgentUri(fs.readFileSync(cfgPath, 'utf-8'));
  } catch (err) {
    log(`agent.uri parse failed: ${err?.message ?? err}`);
    return null;
  }
}

// Read-only consumer of capture-chat's session state. capture-chat
// owns the writes; we only need the slot it reserved for THIS prompt
// (in its `beforeSubmitPrompt` handler, which runs before us).
//
// Returns the index capture-chat will write turn-URI to, or `null`
// if we can't determine it (caller treats `null` as "skip injection"
// — better to lose a session-context block on one turn than predict
// a URI capture-chat doesn't honour).
//
// `pendingTurnIndex` is the canonical value: it's reserved fresh in
// every beforeSubmitPrompt via `maxAssignedTurnIndex`, so it's
// guaranteed unique across the session's lifetime, even when a
// previous afterAgentResponse write failed (Codex PR #589 finding 1).
// `turnIndex + 1` is the legacy back-compat fallback for state files
// written by capture-chat versions that predate `pendingTurnIndex`.
function loadPendingTurnIndex(sessionKey) {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, `${sessionKey}.json`), 'utf-8');
    const state = JSON.parse(raw);
    if (typeof state.pendingTurnIndex === 'number') return state.pendingTurnIndex;
    if (typeof state.turnIndex === 'number') return state.turnIndex + 1;
    return 1;
  } catch {
    // Missing state file → either turn 1 of a fresh session OR
    // capture-chat errored out before writing state. Returning `null`
    // makes main() fall back to skipping injection rather than
    // predicting a URI that may collide.
    return null;
  }
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf-8').trim();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { rawPayload: text }; }
  } catch (err) {
    log(`stdin read failed: ${err?.message ?? err}`);
    return {};
  }
}

export function renderBlock({ sessionKey, nextTurnIndex, turnUri, agentUri }) {
  // Wrapping tags make this a structured notice the agent's prompt
  // parser sees as metadata, not free text. Four fields keep the
  // prompt-budget hit minimal.
  return [
    '<dkg-session-context>',
    `  <session-id>${sessionKey}</session-id>`,
    `  <next-turn-index>${nextTurnIndex}</next-turn-index>`,
    `  <turn-uri>${turnUri}</turn-uri>`,
    `  <agent-uri>${agentUri ?? '(unknown)'}</agent-uri>`,
    '</dkg-session-context>',
  ].join('\n');
}

async function main() {
  const payload = await readStdinJson();
  const sessionKey = extractSessionKey(payload);
  const userPrompt = extractPrompt(payload);

  // FAIL CLOSED on missing inputs. If sessionKey is null we cannot
  // build a useful turn URI. If userPrompt is empty, emitting
  // updated_input would silently REPLACE the operator's prompt with
  // just our block — see the same guard in inject-inbox.mjs.
  if (!sessionKey || !userPrompt) {
    log(`skipping injection: sessionKey=${!!sessionKey} prompt=${!!userPrompt}`);
    process.stdout.write('{}\n');
    return;
  }

  const nextTurnIndex = loadPendingTurnIndex(sessionKey);
  // No state file (capture-chat ran before us but errored out, or
  // never ran at all on this hook ordering) → skip injection. Better
  // to lose a session-context block on one turn than predict a URI
  // capture-chat doesn't honour.
  if (nextTurnIndex == null) {
    log(`skipping injection: no capture-chat session state for ${sessionKey}`);
    process.stdout.write('{}\n');
    return;
  }
  // Mirror capture-chat.mjs `turnUri(slug, idx)`. For sanitised slugs
  // encodeURIComponent is a no-op, but we keep it for byte-alignment
  // with the producer of the URI we're predicting.
  const turnUri = `urn:dkg:chat:session:${encodeURIComponent(sessionKey)}#turn:${nextTurnIndex}`;
  const agentUri = loadAgentUri();

  const block = renderBlock({ sessionKey, nextTurnIndex, turnUri, agentUri });
  const updatedInput = `${block}\n\n${userPrompt}`;

  process.stdout.write(JSON.stringify({ updated_input: updatedInput }) + '\n');
  log(`injected: session=${sessionKey} nextTurn=${nextTurnIndex} agent=${agentUri ?? '(none)'} promptLen=${userPrompt.length}`);
}

// Self-execute only when invoked directly (avoids running during
// import from a future unit test). Mirrors the Windows-safe pattern
// used by inject-inbox.mjs / capture-chat.mjs: `fileURLToPath` round-
// trips the module URL into a real filesystem path so the equality
// check works on Windows too (where `new URL("file://" + path)` would
// otherwise mangle drive-letter paths and silently disable the hook).
const isMainModule = (() => {
  try {
    if (!process.argv[1]) return false;
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    log(`unexpected error: ${err?.stack ?? err?.message ?? err}`);
    process.stdout.write('{}\n');
  });
}
