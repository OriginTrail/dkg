#!/usr/bin/env node
/**
 * capture-chat.mjs
 *
 * Cursor / Claude Code hook script. Bridges coding-assistant chat turns
 * into a DKG project's `chat` sub-graph so teammates on the same CG can
 * see what your assistant is working on (and let their assistants query
 * it back via MCP).
 *
 * Event model (V10 — V9 prompt-injection sub-system retired in #18 / #21)
 * -----------------------------------------------------------------------
 * Cursor invokes this same script for two events, passing the event
 * payload on stdin as JSON:
 *
 *   beforeSubmitPrompt — stash the pending user prompt for the next turn
 *   afterAgentResponse — flush (user prompt + assistant response) as one chat:Turn
 *
 * The `sessionStart` and `sessionEnd` hook events that the V9 version
 * handled have been retired — they only existed to (a) inject V9-era
 * additionalContext (annotation-protocol scaffolding now gone with the
 * dropped sugared-write tools), and (b) auto-register an Agent entity
 * in `meta` (V9-onboarding-specific). The remaining `chat:Session`
 * triple write is handled lazily as a "bootstrap" inside
 * `handleAfterAgentResponse` on the first turn of any session whose
 * Session entity hasn't been written yet, so dropping `sessionStart`
 * loses no V10-relevant behaviour.
 *
 * The event name is passed as argv[2]:
 *
 *   node capture-chat.mjs <eventName>
 *
 * Design principles
 * -----------------
 * 1. FAIL OPEN. This script must never block the user's chat. Any error
 *    is logged to /tmp/dkg-capture.log and we still exit 0 with `{}`
 *    on stdout.
 * 2. CANONICAL DKG OPS. Writes go through the existing
 *    `POST /api/assertion/<name>/write` (JSON triples) and promotes
 *    through `POST /api/assertion/<name>/promote`, matching every
 *    other seeding script in the repo.
 * 3. NO PROMPT INJECTION. Per the V10 retirement of sugared writes
 *    (#18) and the dropped agent-instruction protocol (#21), this hook
 *    no longer returns `additionalContext` / per-turn reminders. Agents
 *    are not told from this hook to call any specific MCP tool; the
 *    canonical V10 tool surface lives in `packages/cli/skills/dkg-node/SKILL.md`.
 * 4. NO NEW CONFIG SURFACE. Reads `.dkg/config.yaml` walking upward
 *    from cwd. See `22_AGENT_ONBOARDING §2.1` for the canonical shape.
 *
 * Cross-reference: the OpenClaw adapter's `ChatTurnWriter` at
 * `packages/adapter-openclaw/src/ChatTurnWriter.ts` writes the same
 * `chat:Turn` shape (predicates + sub-graph) into the same context
 * graph from a different ingestion path. Predicates and sub-graph
 * names below stay byte-aligned with that writer so a turn captured
 * via either surface lands in the same RDF shape.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ── Constants ─────────────────────────────────────────────────
const EVENT = process.argv[2] ?? 'unknown';
const LOG_FILE = process.env.DKG_CAPTURE_LOG ?? '/tmp/dkg-capture.log';
const STATE_DIR = path.join(os.homedir(), '.cache', 'dkg-mcp', 'sessions');
const DEFAULT_API = 'http://localhost:9200';

const NS = {
  rdf:     'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs:    'http://www.w3.org/2000/01/rdf-schema#',
  schema:  'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  xsd:     'http://www.w3.org/2001/XMLSchema#',
  prov:    'http://www.w3.org/ns/prov#',
  chat:    'http://dkg.io/ontology/chat/',
  agent:   'http://dkg.io/ontology/agent/',
};
const T = {
  Session: NS.chat + 'Session',
  Turn:    NS.chat + 'Turn',
};
const P = {
  type:      NS.rdf + 'type',
  label:     NS.rdfs + 'label',
  name:      NS.schema + 'name',
  created:   NS.dcterms + 'created',
  modified:  NS.dcterms + 'modified',
  attributed: NS.prov + 'wasAttributedTo',
  inSession: NS.chat + 'inSession',
  turnIndex: NS.chat + 'turnIndex',
  userPrompt: NS.chat + 'userPrompt',
  assistantResponse: NS.chat + 'assistantResponse',
  speakerTool: NS.chat + 'speakerTool',
  privacy:   NS.chat + 'privacy',
  contentHash: NS.chat + 'contentHash',
  rawPayload: NS.chat + 'rawPayload',
  // Optional metadata predicates — best-effort enrichment from tool payload.
  model:         NS.chat + 'model',
  composerMode:  NS.chat + 'composerMode',
  generationId:  NS.chat + 'generationId',
  toolVersion:   NS.chat + 'toolVersion',
  transcriptPath: NS.chat + 'transcriptPath',
};

// Cap any single literal to keep assertions reasonable; coding-agent
// responses can balloon to tens of KB, which isn't useful for search.
const LITERAL_CAP = 20_000;

// ── Logging ───────────────────────────────────────────────────
function log(msg) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} [${EVENT}] ${msg}\n`,
    );
  } catch {
    // Cannot log → give up silently; the hook must stay non-blocking.
  }
}

// ── Config loader (walks upward for .dkg/config.yaml) ─────────
// We intentionally avoid a YAML dep here — the hook runs under Cursor's
// constrained environment and bundling `yaml` would slow every event.
// The config shape we care about is line-oriented enough that a tiny
// hand-rolled parser covers every realistic case.
export function parseDotDkgConfig(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const cfg = { node: {}, agent: {}, capture: {} };
  let stack = [cfg];
  let indents = [-1];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    while (indents.length > 1 && indent <= indents[indents.length - 1]) {
      stack.pop();
      indents.pop();
    }
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valRaw = m[2];
    const parent = stack[stack.length - 1];
    if (valRaw === '' || valRaw === undefined) {
      parent[key] = {};
      stack.push(parent[key]);
      indents.push(indent);
    } else {
      const val = valRaw
        .replace(/^["']|["']$/g, '')
        .trim();
      if (val === 'true') parent[key] = true;
      else if (val === 'false') parent[key] = false;
      else if (/^-?\d+$/.test(val)) parent[key] = parseInt(val, 10);
      else parent[key] = val;
    }
  }
  return cfg;
}

function findConfigFile(start) {
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

function loadConfig() {
  const envApi = process.env.DKG_API ?? process.env.DEVNET_API;
  const envToken = process.env.DKG_TOKEN ?? process.env.DEVNET_TOKEN;
  const envProject = process.env.DKG_PROJECT;
  const envAgent = process.env.DKG_AGENT_URI;

  const cwd = process.env.DKG_WORKSPACE ?? process.cwd();
  const cfgPath = findConfigFile(cwd);
  let fromFile = { node: {}, agent: {}, capture: {} };
  if (cfgPath) {
    try {
      fromFile = parseDotDkgConfig(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (err) {
      log(`could not parse ${cfgPath}: ${err?.message ?? err}`);
    }
  }

  let token = envToken ?? fromFile.node?.token ?? '';
  if (!token && fromFile.node?.tokenFile && cfgPath) {
    try {
      // Expand a leading `~/` (or bare `~`) before deciding absolute-vs-relative.
      // Without this the very common `~/.dkg/auth.token` config silently
      // resolves to `<workspace>/.dkg/~/.dkg/auth.token` (gibberish), token
      // stays empty, every write 401s. Mirrors the same fix in
      // packages/mcp-dkg/src/config.ts.
      const tokenFileExpanded = fromFile.node.tokenFile === '~'
        ? os.homedir()
        : (fromFile.node.tokenFile.startsWith('~/')
            ? path.join(os.homedir(), fromFile.node.tokenFile.slice(2))
            : fromFile.node.tokenFile);
      const abs = path.isAbsolute(tokenFileExpanded)
        ? tokenFileExpanded
        : path.resolve(path.dirname(cfgPath), tokenFileExpanded);
      const raw = fs.readFileSync(abs, 'utf-8');
      const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('#'));
      token = (line ?? '').trim();
    } catch (err) {
      log(`tokenFile read failed: ${err?.message ?? err}`);
    }
  }

  return {
    api: fromFile.node?.api ?? envApi ?? DEFAULT_API,
    token,
    project: fromFile.contextGraph ?? fromFile.project ?? envProject ?? null,
    agent: fromFile.agent?.uri ?? envAgent ?? null,
    subGraph: fromFile.capture?.subGraph ?? 'chat',
    assertion: fromFile.capture?.assertion ?? 'chat-log',
    privacy: fromFile.capture?.privacy ?? 'team',
    autoShare: fromFile.autoShare !== false,
    // `tool` intentionally prefers DKG_CAPTURE_TOOL when the per-tool
    // hook script exports it — each tool's hook command line wires
    // `cursor` or `claude-code` explicitly, and that runtime signal
    // must win over any static config.yaml value.
    tool: process.env.DKG_CAPTURE_TOOL ?? fromFile.capture?.tool ?? 'cursor',
    sourcePath: cfgPath,
  };
}

// ── Session state ─────────────────────────────────────────────
function sessionStatePath(sessionKey) {
  return path.join(STATE_DIR, `${sessionKey}.json`);
}

function loadSessionState(sessionKey) {
  try {
    const raw = fs.readFileSync(sessionStatePath(sessionKey), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSessionState(sessionKey, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(sessionStatePath(sessionKey), JSON.stringify(state, null, 2));
}

// ── stdin / payload parsing ───────────────────────────────────
async function readStdinJson() {
  // Non-blocking drain of stdin. If stdin is a TTY (e.g. when debugging
  // by running the script by hand), fall back to an empty object.
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

// Generic deep-search for the first matching key. Used to pluck prompt
// text / response text / conversation id from whatever shape Cursor uses
// without us having to know it exactly up front.
export function pick(obj, candidates, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== 'object') return undefined;
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, c)) {
      const v = obj[c];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const nested = pick(v, candidates, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function extractText(payload) {
  // Field names confirmed from Cursor 3.1.15 payloads (2026-04-18):
  //   beforeSubmitPrompt → { prompt, conversation_id, … }
  //   afterAgentResponse → { text, conversation_id, model, … }
  // We keep snake_case and camelCase variants in the list so the hook
  // also works with Claude Code / Aider / future tools without edits.
  const t = pick(payload, [
    // User prompts
    'prompt', 'userPrompt', 'user_prompt', 'request', 'input',
    // Assistant responses (Cursor uses `text`; Claude Code's Stop event
    // uses `last_assistant_message`; others vary)
    'text', 'response', 'reply', 'completion', 'output', 'answer',
    'last_assistant_message', 'lastAssistantMessage',
    // Generic envelopes some frameworks wrap in
    'message', 'content',
  ]);
  return t ?? '';
}

export function extractSessionKey(payload) {
  const id = pick(payload, [
    // Cursor 3.1.15 uses snake_case at top level
    'conversation_id', 'session_id', 'thread_id', 'chat_id',
    // camelCase + short aliases for other frameworks
    'conversationId', 'sessionId', 'threadId', 'chatId', 'convId', 'id',
  ]);
  if (id) return sanitiseSlug(id);
  // No id from the tool? Synthesize a unique, per-invocation key and
  // persist it in a small index file so repeated events from the same
  // shell process share the same session.
  return sanitiseSlug(anonSessionKey());
}

function anonSessionKey() {
  try {
    const stateDir = path.join(os.homedir(), '.dkg', 'hook-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const idxFile = path.join(stateDir, `anon-session-${process.ppid || process.pid}.txt`);
    if (fs.existsSync(idxFile)) {
      const buf = fs.readFileSync(idxFile, 'utf-8').trim();
      if (buf) return buf;
    }
    const fresh = `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    fs.writeFileSync(idxFile, fresh, 'utf-8');
    return fresh;
  } catch {
    return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Pull optional metadata Cursor sends that enriches a Session/Turn
 *  without being strictly required. Missing values return undefined so
 *  we can skip emitting the predicate rather than write empty strings. */
function extractMeta(payload) {
  return {
    model: pick(payload, ['model', 'modelId', 'model_id']),
    mode: pick(payload, ['composer_mode', 'mode']),
    generationId: pick(payload, ['generation_id', 'generationId']),
    toolVersion: pick(payload, ['cursor_version', 'client_version', 'tool_version']),
    transcriptPath: pick(payload, ['transcript_path', 'transcriptPath']),
  };
}

export function sanitiseSlug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
}

// ── RDF helpers ───────────────────────────────────────────────
const LIT = (v, datatype) => {
  const capped = typeof v === 'string' && v.length > LITERAL_CAP
    ? v.slice(0, LITERAL_CAP) + `…[truncated ${v.length - LITERAL_CAP} chars]`
    : String(v);
  const esc = capped
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (datatype) return `"${esc}"^^<${datatype}>`;
  return `"${esc}"`;
};
const URI = (u) => u; // daemon's /write expects bare URIs in subject/predicate

const sessionUri = (slug) => `urn:dkg:chat:session:${encodeURIComponent(slug)}`;
const turnUri = (slug, idx) => `urn:dkg:chat:session:${encodeURIComponent(slug)}#turn:${idx}`;

// ── Daemon calls ──────────────────────────────────────────────
async function postJson(api, route, token, body) {
  const res = await fetch(`${api}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${route} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Low-level write. Each turn gets its own named assertion graph so a
 * write for turn N cannot overwrite the one for turn N-1, and each
 * turn can be promoted/discarded independently.
 */
async function writeTriples(cfg, triples, assertionName = cfg.assertion) {
  return postJson(cfg.api, `/api/assertion/${encodeURIComponent(assertionName)}/write`, cfg.token, {
    contextGraphId: cfg.project,
    subGraphName: cfg.subGraph,
    quads: triples,
  });
}

async function promoteEntities(cfg, entities, assertionName = cfg.assertion) {
  return postJson(cfg.api, `/api/assertion/${encodeURIComponent(assertionName)}/promote`, cfg.token, {
    contextGraphId: cfg.project,
    subGraphName: cfg.subGraph,
    entities,
  });
}

function perTurnAssertionName(cfg, sessionKey, turnIdx) {
  const base = cfg.assertion ?? 'chat-log';
  return sanitiseSlug(`${base}-${sessionKey}-turn-${turnIdx}`);
}

/**
 * Resolve whether a session should auto-promote to SWM.
 *
 * Rules (in order):
 *   1. If `cfg.autoShare` is false for this operator, never promote.
 *   2. If the session has an explicit `chat:privacy "private"` flag in
 *      any memory layer, never promote — the operator explicitly opted
 *      out for this thread (via direct daemon writes or the node UI;
 *      the V9 MCP tool that used to flip this in-band is retired).
 *   3. Otherwise, promote.
 *
 * Re-reads each turn (no cache) so a mid-session privacy flip is
 * respected — caching once-per-session leaked private turns into SWM
 * in the V9 implementation.
 */
async function shouldPromote(cfg, state) {
  if (!cfg.autoShare) return false;
  try {
    const q = `
      SELECT ?p WHERE {
        <${state.sessionUri}> <${P.privacy}> ?p .
      } LIMIT 1`;
    const body = await postJson(cfg.api, '/api/query', cfg.token, {
      contextGraphId: cfg.project,
      subGraphName: cfg.subGraph,
      sparql: q,
      includeSharedMemory: true,
    });
    const row = body?.result?.bindings?.[0];
    const raw = row ? String(row.p ?? '') : '';
    const privacy = raw.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '').replace(/"@.+$/, '') || 'team';
    return privacy !== 'private';
  } catch (err) {
    log(`shouldPromote: privacy query failed (${err?.message ?? err}); falling back to cfg.autoShare=${cfg.autoShare}`);
    return cfg.autoShare;
  }
}

// ── Ensure sub-graph exists (no-op if already registered) ─────
async function ensureSubGraph(cfg, name) {
  const target = name ?? cfg.subGraph;
  try {
    await postJson(cfg.api, `/api/sub-graph/create`, cfg.token, {
      contextGraphId: cfg.project,
      subGraphName: target,
    });
  } catch (err) {
    // Already-exists is the 99% case; anything else we log + move on.
    const m = String(err?.message ?? err);
    if (!m.includes('already exists')) log(`ensureSubGraph(${target}): ${m}`);
  }
}

// ── Triple builders ───────────────────────────────────────────
function sessionTriples(cfg, state, payload) {
  const triples = [
    { subject: state.sessionUri, predicate: P.type, object: URI(T.Session) },
    { subject: state.sessionUri, predicate: P.name, object: LIT(`${cfg.tool} session ${state.sessionKey}`) },
    { subject: state.sessionUri, predicate: P.created, object: LIT(state.startedAt, NS.xsd + 'dateTime') },
    { subject: state.sessionUri, predicate: P.speakerTool, object: LIT(cfg.tool) },
    { subject: state.sessionUri, predicate: P.privacy, object: LIT(cfg.privacy) },
  ];
  if (cfg.agent) triples.push({ subject: state.sessionUri, predicate: P.attributed, object: URI(cfg.agent) });
  const meta = extractMeta(payload);
  if (meta.model)       triples.push({ subject: state.sessionUri, predicate: P.model,       object: LIT(meta.model) });
  if (meta.toolVersion) triples.push({ subject: state.sessionUri, predicate: P.toolVersion, object: LIT(meta.toolVersion) });
  return triples;
}

// ── Event handlers ────────────────────────────────────────────

async function handleBeforeSubmitPrompt(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const state = loadSessionState(sessionKey) ?? {
    sessionKey,
    sessionUri: sessionUri(sessionKey),
    startedAt: new Date().toISOString(),
    turnIndex: 0,
    pendingPrompt: null,
  };
  state.pendingPrompt = extractText(payload) ?? '';
  state.pendingPromptAt = new Date().toISOString();
  saveSessionState(sessionKey, state);
  log(`queued prompt (${state.pendingPrompt.length} chars) for session ${sessionKey}`);
}

async function handleAfterAgentResponse(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const state = loadSessionState(sessionKey) ?? {
    sessionKey,
    sessionUri: sessionUri(sessionKey),
    startedAt: new Date().toISOString(),
    turnIndex: 0,
    pendingPrompt: null,
  };
  // Compute the next index *without* committing it yet. We only advance
  // state.turnIndex (and clear pendingPrompt) after writeTriples()
  // succeeds — otherwise a transient daemon/network error would silently
  // burn a turn slot and shift numbering for every subsequent turn.
  const idx = state.turnIndex + 1;
  const turn = turnUri(sessionKey, idx);
  const now = new Date().toISOString();
  const userText = state.pendingPrompt ?? '';
  const asstText = extractText(payload) ?? '';
  const meta = extractMeta(payload);
  const hash = crypto.createHash('sha256').update(userText + '\0' + asstText).digest('hex').slice(0, 32);

  if (!cfg.project) { log('no project configured — skipping turn write'); return; }
  await ensureSubGraph(cfg);

  // Bootstrap: the V9 `sessionStart` hook is retired, so EVERY first
  // turn of a session needs to also emit the Session triples alongside
  // the Turn so the UI / MCP always sees a proper `chat:Session` entity
  // pointing to its `chat:Turn`s.
  const bootstrapSession = idx === 1 && !state.sessionWritten;
  const triples = [
    { subject: turn, predicate: P.type, object: URI(T.Turn) },
    { subject: turn, predicate: P.inSession, object: URI(state.sessionUri) },
    { subject: turn, predicate: P.turnIndex, object: LIT(idx, NS.xsd + 'integer') },
    { subject: turn, predicate: P.created, object: LIT(now, NS.xsd + 'dateTime') },
    { subject: turn, predicate: P.contentHash, object: LIT(hash) },
    { subject: turn, predicate: P.speakerTool, object: LIT(cfg.tool) },
  ];
  if (userText) triples.push({ subject: turn, predicate: P.userPrompt, object: LIT(userText) });
  if (asstText) triples.push({ subject: turn, predicate: P.assistantResponse, object: LIT(asstText) });
  if (cfg.agent) triples.push({ subject: turn, predicate: P.attributed, object: URI(cfg.agent) });
  if (meta.model)          triples.push({ subject: turn, predicate: P.model,          object: LIT(meta.model) });
  if (meta.mode)           triples.push({ subject: turn, predicate: P.composerMode,   object: LIT(meta.mode) });
  if (meta.generationId)   triples.push({ subject: turn, predicate: P.generationId,   object: LIT(meta.generationId) });
  if (meta.toolVersion)    triples.push({ subject: turn, predicate: P.toolVersion,    object: LIT(meta.toolVersion) });
  if (meta.transcriptPath) triples.push({ subject: turn, predicate: P.transcriptPath, object: LIT(meta.transcriptPath) });
  // When nothing could be extracted (unfamiliar payload shape) stash
  // the raw JSON so we can post-hoc reconstruct turns once we see real
  // data.
  if (!userText && !asstText) {
    try {
      triples.push({ subject: turn, predicate: P.rawPayload, object: LIT(JSON.stringify(payload)) });
    } catch {
      /* payload wasn't JSON-serialisable; give up */
    }
  }

  // Also keep session `modified` fresh so timelines sort correctly.
  triples.push({ subject: state.sessionUri, predicate: P.modified, object: LIT(now, NS.xsd + 'dateTime') });
  if (bootstrapSession) {
    triples.push(...sessionTriples(cfg, state, payload));
  }

  let writeOk = false;
  const turnAssertion = perTurnAssertionName(cfg, sessionKey, idx);
  try {
    await writeTriples(cfg, triples, turnAssertion);
    writeOk = true;
    state.turnIndex = idx;
    state.pendingPrompt = null;
    if (bootstrapSession) state.sessionWritten = true;
    if (await shouldPromote(cfg, state)) {
      // Promote both the session and the individual turn so the team
      // sees the turn immediately and the aggregate Session is kept
      // in SWM.
      await promoteEntities(cfg, [turn, state.sessionUri], turnAssertion).catch((e) => log(`promote turn: ${e.message}`));
    } else if (cfg.autoShare) {
      log(`auto-share skipped: session ${sessionKey} is private`);
    }
    log(`wrote turn #${idx} for session ${sessionKey}${bootstrapSession ? ' (bootstrapped session)' : ''}`);
  } catch (err) {
    // Leave state.turnIndex + state.pendingPrompt untouched so the next
    // afterAgentResponse retries the same slot with the same prompt.
    log(`turn write failed (turn #${idx} not committed; will retry next event): ${err?.message ?? err}`);
  }

  state.lastEventAt = now;
  saveSessionState(sessionKey, state);
  return writeOk;
}

// ── Main dispatch ─────────────────────────────────────────────
//
// Self-execute only when invoked directly (avoids running the IIFE
// when the module is imported by a test).
const isMainModule = (() => {
  try {
    if (!process.argv[1]) return false;
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) (async () => {
  const payload = await readStdinJson();
  const cfg = loadConfig();
  log(`cfg: api=${cfg.api} project=${cfg.project} agent=${cfg.agent} token=${cfg.token ? '[set]' : '[empty]'} autoShare=${cfg.autoShare}`);
  try {
    switch (EVENT) {
      // Cursor native events + Claude Code equivalents:
      //   beforeSubmitPrompt  ≡ UserPromptSubmit   (prompt stashed for turn)
      //   afterAgentResponse  ≡ Stop               (assistant finished responding)
      //
      // The V9 `sessionStart` / `sessionEnd` events are retired —
      // see the file-header docblock for rationale. Hook configs
      // referencing them are no-ops.
      case 'beforeSubmitPrompt':
      case 'UserPromptSubmit':
        await handleBeforeSubmitPrompt(cfg, payload);
        break;
      case 'afterAgentResponse':
      case 'Stop':
        await handleAfterAgentResponse(cfg, payload);
        break;
      default:
        log(`unknown or retired event: ${EVENT}`);
    }
  } catch (err) {
    log(`handler error: ${err?.stack ?? err?.message ?? err}`);
  }
  // Emit empty `{}` per fail-open contract — no `additionalContext`
  // injection in V10 (the V9 prompt-injection sub-system is retired).
  process.stdout.write('{}\n');
  process.exit(0);
})();
