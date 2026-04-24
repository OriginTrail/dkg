#!/usr/bin/env node
/**
 * capture-chat.mjs
 *
 * Cursor / Claude Code hook script. Bridges coding-assistant chat turns
 * into a DKG project's `chat` sub-graph so teammates on the same CG can
 * see what your assistant is working on (and let their assistants query
 * it back via MCP).
 *
 * Event model
 * -----------
 * Cursor invokes this same script for four events, passing the event
 * payload on stdin as JSON:
 *
 *   sessionStart      — initialise session state + emit chat:Session triples
 *   beforeSubmitPrompt — stash the pending user prompt for the next turn
 *   afterAgentResponse — flush (user prompt + assistant response) as one chat:Turn
 *   sessionEnd        — close the session (soft — we don't delete state)
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
 * 2. DEFENSIVE PARSING. Cursor's event schema isn't fully documented;
 *    we try several common field names before giving up, and fall
 *    back to stashing the whole payload as `rawPayload` so no
 *    information is lost.
 * 3. CANONICAL DKG OPS. Writes go through the existing
 *    `POST /api/assertion/<name>/write` (JSON triples) and promotes
 *    through `POST /api/assertion/<name>/promote`, matching every
 *    other seeding script in the repo.
 * 4. NO NEW CONFIG SURFACE. Reads `.dkg/config.yaml` walking upward
 *    from cwd. See `22_AGENT_ONBOARDING §2.1` for the canonical shape.
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
  aboutEntity: NS.chat + 'aboutEntity',
  mentions:  NS.chat + 'mentions',
  summary:   NS.chat + 'summary',
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
  const envNickname = process.env.DKG_AGENT_NICKNAME;

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
      log(`token file unreadable: ${err?.message ?? err}`);
    }
  }

  // Precedence: project-scoped `.dkg/config.yaml` WINS over shell env
  // vars. A `dkg-mcp join` installation writes the authoritative
  // values to the workspace's config.yaml; the env vars (DKG_API,
  // DKG_TOKEN, DKG_PROJECT, DKG_AGENT_URI, DKG_AGENT_NICKNAME) exist
  // for bootstrapping (e.g. devnet scripts that run BEFORE a config
  // file exists) and for .cursor/mcp.json wiring — neither of those
  // should silently shadow a checked-in per-project config. That is:
  // the user who committed `agent.nickname: "Brana laptop 2"` expects
  // that label to appear on the graph even if their shell still has
  // DKG_AGENT_NICKNAME exported from an earlier session.
  //
  // Reversing this was an accidental regression caught by Codex. Same
  // precedence ordering is mirrored in packages/mcp-dkg/src/config.ts
  // (the TS-side loader) so runtime and hook agree.
  return {
    api: fromFile.node?.api ?? envApi ?? DEFAULT_API,
    token,
    project: fromFile.contextGraph ?? fromFile.project ?? envProject ?? null,
    agent: fromFile.agent?.uri ?? envAgent ?? null,
    // Free-form human label rendered as rdfs:label / schema:name on the
    // agent entity. Falls back to the URI tail for legacy slug-only configs.
    nickname: fromFile.agent?.nickname ?? envNickname ?? null,
    subGraph: fromFile.capture?.subGraph ?? 'chat',
    assertion: fromFile.capture?.assertion ?? 'chat-log',
    privacy: fromFile.capture?.privacy ?? 'team',
    autoShare: fromFile.autoShare !== false,
    // `tool` intentionally prefers DKG_CAPTURE_TOOL when the per-tool
    // hook script exports it — each tool's hook command line wires
    // `cursor` or `claude-code` explicitly, and that runtime signal
    // must win over any static config.yaml value (otherwise a user
    // with both Cursor + Claude installed records every turn as the
    // tool they happened to put in their yaml). See the long comment
    // in templates.ts CONFIG_YAML_TEMPLATE.
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
// without us having to know it exactly up front. The spike hook
// (dump-spike.mjs) tells us the real field names; this function lets us
// bridge that gap without breaking once we learn them.
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
  // shell process share the same session. The previous fallback used
  // the current hour, which silently merged unrelated conversations
  // that happened to run in the same 60-minute window.
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
    // If we can't persist, fall back to per-invocation; still much
    // safer than the hourly bucket — at worst we lose session grouping
    // across events but never merge unrelated conversations.
    return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Pull optional metadata Cursor sends that enriches a Session/Turn
 *  without being strictly required. Missing values return undefined so
 *  we can skip emitting the predicate rather than write empty strings. */
function extractMeta(payload) {
  return {
    // The model that produced the response — valuable for auditability.
    // Cursor: "claude-opus-4-7", Claude Code likely similar.
    model: pick(payload, ['model', 'modelId', 'model_id']),
    // Mode context (Cursor: "agent" / "ask"). Useful for filtering out
    // quick-question turns from deep agentic sessions.
    mode: pick(payload, ['composer_mode', 'mode']),
    // Short generation id; lets us dedupe retried turns on the same
    // conversation even before contentHash fires.
    generationId: pick(payload, ['generation_id', 'generationId']),
    // The tool's own version string (Cursor: "3.1.15"). Handy if a
    // future payload shape change breaks capture — we know exactly
    // which client version is in play.
    toolVersion: pick(payload, ['cursor_version', 'client_version', 'tool_version']),
    // Transcript file on disk (Cursor persists a jsonl). Stored so
    // downstream jobs can fetch the full raw transcript if needed.
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
 * Low-level write. Callers pass an assertion name so each logical
 * write-unit (a single turn, the agent-self-register, a session
 * bootstrap, …) gets its own named assertion graph. Sharing one
 * `cfg.assertion` across many writes would couple every turn's
 * promote/discard lifecycle together and (per `/api/assertion/…/write`
 * semantics) risk clobbering already-committed turn history.
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

/**
 * Build a per-turn assertion name. Including the session key + turn
 * index keeps successive turns in distinct assertion graphs, so a
 * write for turn N cannot overwrite the one for turn N-1 even under
 * the most-permissive `/api/assertion/…/write` semantics, and each
 * turn can be promoted/discarded independently.
 */
function perTurnAssertionName(cfg, sessionKey, turnIdx) {
  const base = cfg.assertion ?? 'chat-log';
  return sanitiseSlug(`${base}-${sessionKey}-turn-${turnIdx}`);
}

/**
 * Resolve whether a session should auto-promote to SWM.
 *
 * Rules (in order):
 *   1. If `cfg.autoShare` is false for this operator, never promote.
 *   2. If the session has an explicit `chat:privacy "private"` flag
 *      (set by `dkg_set_session_privacy`) in any memory layer, never
 *      promote — the operator explicitly opted out for this thread.
 *   3. Otherwise, promote.
 *
 * **No caching.** Re-reading the privacy triple each turn costs one
 * cheap SPARQL query but is the only way to respect a mid-session
 * `dkg_set_session_privacy` flip: the store is authoritative, and
 * hooks run in a short-lived Node process whose `state` is loaded
 * fresh from disk each turn but not round-tripped through the daemon
 * between turns. An earlier version cached `state.privacyCached` on
 * first hit, but that cache never invalidated — once a session's first
 * turn observed e.g. `team`, every subsequent flip to `private` was
 * ignored for the rest of the session lifetime, leaking turns into
 * SWM. One query per turn is well within budget (the hook already
 * makes multiple `/api/*` calls per turn).
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

// ── Self-register the agent in `meta` on first sessionStart ────
//
// Without this, operator B has to manually `node scripts/import-agents.mjs`
// before their first chat turn or attribution chips render bare URIs in
// the UI. Self-register writes a minimal Agent entity (label, framework,
// joinedAt) into a per-agent assertion (`agent-self-register-<slug>`)
// so it doesn't clobber other agents in `meta/participants`. Idempotent:
// the per-session state file remembers we've done it so subsequent
// sessionStart events skip the write.
async function selfRegisterAgent(cfg, state) {
  if (!cfg.agent) return;
  if (state.agentRegistered) return;
  // Phase 8 nickname/wallet split: cfg.agent is the canonical URI
  // (typically `urn:dkg:agent:<wallet-address>` from the manifest install).
  // The human-friendly label comes from cfg.nickname (set by config.yaml's
  // `agent.nickname`); fall back to the URI tail for old slug-based configs.
  const uriTail = cfg.agent.split(':').pop() ?? 'unknown-agent';
  const nickname = cfg.nickname || uriTail;
  // Assertion name needs to be filesystem/URL-safe, so use the URI tail
  // (a wallet address — already safe — or a slug).
  const assertion = `agent-self-register-${uriTail.replace(/[^a-z0-9-]/gi, '-')}`;
  const triples = [
    { subject: cfg.agent, predicate: P.type, object: URI(NS.agent + 'Agent') },
    { subject: cfg.agent, predicate: P.type, object: URI(NS.agent + 'AIAgent') },
    { subject: cfg.agent, predicate: P.label, object: LIT(nickname) },
    { subject: cfg.agent, predicate: P.name, object: LIT(nickname) },
    { subject: cfg.agent, predicate: NS.agent + 'framework', object: LIT(cfg.tool) },
    { subject: cfg.agent, predicate: NS.agent + 'joinedAt', object: LIT(state.startedAt, NS.xsd + 'dateTime') },
  ];
  // Stamp the wallet address as a separate predicate when we have one.
  // Heuristic: agent URIs of the shape urn:dkg:agent:0x[hex40] embed the
  // wallet directly. Stash it as a first-class triple so SPARQL queries
  // can correlate agents to wallets without parsing URI strings.
  const walletMatch = cfg.agent.match(/urn:dkg:agent:(0x[a-fA-F0-9]{40})$/);
  if (walletMatch) {
    triples.push({
      subject: cfg.agent,
      predicate: NS.agent + 'walletAddress',
      object: LIT(walletMatch[1].toLowerCase()),
    });
  }
  try {
    await ensureSubGraph(cfg, 'meta');
    await postJson(cfg.api, `/api/assertion/${encodeURIComponent(assertion)}/write`, cfg.token, {
      contextGraphId: cfg.project,
      subGraphName: 'meta',
      quads: triples,
    });
    if (cfg.autoShare) {
      await postJson(cfg.api, `/api/assertion/${encodeURIComponent(assertion)}/promote`, cfg.token, {
        contextGraphId: cfg.project,
        subGraphName: 'meta',
        entities: [cfg.agent],
      }).catch((e) => log(`promote agent self-register: ${e.message}`));
    }
    state.agentRegistered = true;
    log(`self-registered agent ${cfg.agent} in meta/${assertion}`);
  } catch (err) {
    // Don't block the session over this — it's recoverable.
    log(`self-register agent: ${err?.message ?? err}`);
  }
}

// ── Pending-annotation rendezvous ─────────────────────────────
//
// Phase 7 race-fix: agents call `dkg_annotate_turn` with `forSession`
// during their response composition. The MCP tool writes annotation
// triples to a `urn:dkg:pending-annotation:<session>:…` URI tagged with
// `chat:pendingForSession <sessionId>`. After we write the actual turn
// triples here, scan for matching pending annotations and rewrite their
// triples onto the just-written turn URI. This lets the agent annotate
// "the turn I'm about to produce" race-free — no need to predict a turn
// URI that doesn't exist yet.
async function applyPendingAnnotations(cfg, sessionKey, turnUri, promote = false) {
  if (!cfg.project) return 0;
  // NO `GRAPH ?g { … }` wrapper here. The daemon's /api/query handler
  // already scopes the query to `contextGraphId` + `subGraphName` below;
  // explicit GRAPH would open the match up to every graph this token
  // can read, so a pending annotation written from a sibling project on
  // the same daemon (same sessionKey) would get pulled into this turn.
  // Codex tier-4g finding N9.
  const sparql = `SELECT ?pending ?p ?o WHERE {
  ?pending <http://dkg.io/ontology/chat/pendingForSession> "${sessionKey}" ;
           ?p ?o .
  FILTER NOT EXISTS { ?pending <http://dkg.io/ontology/chat/appliedToTurn> ?_t }
}`;
  let bindings = [];
  try {
    const r = await postJson(cfg.api, '/api/query', cfg.token, {
      sparql,
      contextGraphId: cfg.project,
      subGraphName: cfg.subGraph,
      includeSharedMemory: true,
    });
    bindings = r?.result?.bindings ?? [];
  } catch (err) {
    log(`pending-annotations query: ${err?.message ?? err}`);
    return 0;
  }
  if (!bindings.length) return 0;

  // Collect all triples per pending URI so we can rewrite the subject.
  const byPending = new Map();
  for (const row of bindings) {
    const pending = (row.pending?.value ?? row.pending ?? '').toString().replace(/^<|>$/g, '');
    const p = (row.p?.value ?? row.p ?? '').toString().replace(/^<|>$/g, '');
    const oRaw = (row.o?.value ?? row.o ?? '').toString();
    if (!pending || !p) continue;
    if (!byPending.has(pending)) byPending.set(pending, []);
    byPending.get(pending).push({ predicate: p, object: oRaw });
  }
  if (!byPending.size) return 0;

  // For each pending, rewrite triples whose subject is the pending URI
  // onto the real turnUri. Triples whose subject is a co-minted entity
  // (Finding/Question/Decision/Task/Comment/etc.) reference the pending
  // URI as object via chat:proposes/concludes/etc. — those object refs
  // also need rewriting. We do a generic pass: anywhere the pending
  // URI appears in the triples we just queried, swap to turnUri.
  //
  // Simpler approach: query the FULL set of triples involving each
  // pending (as subject OR object) and rewrite. The first query gave
  // us only subject-side triples, so do a second pass for object-side.
  let applied = 0;
  for (const pending of byPending.keys()) {
    let allTriples = byPending.get(pending);
    try {
      // Scoping via contextGraphId + subGraphName below; no GRAPH wrapper
      // so we don't match references from other projects' sub-graphs.
      const objSparql = `SELECT ?s ?p WHERE { ?s ?p <${pending}> }`;
      const r2 = await postJson(cfg.api, '/api/query', cfg.token, {
        sparql: objSparql,
        contextGraphId: cfg.project,
        subGraphName: cfg.subGraph,
        includeSharedMemory: true,
      });
      for (const row of r2?.result?.bindings ?? []) {
        const s = (row.s?.value ?? row.s ?? '').toString().replace(/^<|>$/g, '');
        const p = (row.p?.value ?? row.p ?? '').toString().replace(/^<|>$/g, '');
        if (s && p) allTriples.push({ subject: s, predicate: p, object: `<${turnUri}>` });
      }
    } catch (err) {
      log(`pending object-pass query for ${pending}: ${err?.message ?? err}`);
    }
    // Build the rewritten triple set. Skip the pending-marker triples
    // (pendingForSession, type=PendingAnnotation) — they'd just clutter.
    const rewritten = [];
    for (const t of allTriples) {
      const subject = (t.subject ?? pending) === pending ? turnUri : t.subject;
      const predicate = t.predicate;
      // Drop bookkeeping triples that don't belong on the real turn.
      if (predicate === 'http://dkg.io/ontology/chat/pendingForSession') continue;
      if (predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
          && (t.object === '<http://dkg.io/ontology/chat/PendingAnnotation>'
              || t.object === 'http://dkg.io/ontology/chat/PendingAnnotation')) continue;
      // Object: if it's the pending URI in any wrapping form, swap.
      let object = t.object;
      const bareObj = String(object).replace(/^<|>$/g, '');
      if (bareObj === pending) object = `<${turnUri}>`;
      rewritten.push({ subject, predicate, object });
    }
    if (!rewritten.length) continue;
    // Mark the pending as applied so we don't re-apply on subsequent
    // turn writes for the same session. Use a separate single-triple
    // assertion so the original pending assertion stays untouched
    // (it's a valid historical record of what the agent intended).
    rewritten.push({
      subject: pending,
      predicate: 'http://dkg.io/ontology/chat/appliedToTurn',
      object: `<${turnUri}>`,
    });
    const applyAssertion = `agent-annotate-applied-${pending.replace(/[^A-Za-z0-9]+/g, '-').slice(-30)}`;
    // Collect every co-minted entity URI that appears as a SUBJECT in
    // the rewritten quad set (Findings / Questions / Decisions / Tasks
    // / Comments / mention-targets). The /promote endpoint filters the
    // exported assertion by subject root, so if we only list `turnUri`
    // the rewritten annotation triples whose subject is one of these
    // co-minted entities get silently dropped from the SWM export and
    // peers never see them. See Codex tier-4g finding N8.
    const promoteEntities = new Set([turnUri]);
    for (const t of rewritten) {
      if (!t.subject) continue;
      if (t.subject === pending) continue; // the appliedToTurn marker
      if (t.subject === turnUri) continue; // already covered
      promoteEntities.add(t.subject);
    }
    try {
      await postJson(cfg.api, `/api/assertion/${encodeURIComponent(applyAssertion)}/write`, cfg.token, {
        contextGraphId: cfg.project,
        subGraphName: cfg.subGraph,
        quads: rewritten,
      });
      // Only promote when the caller determined this turn is
      // promotable (cfg.autoShare AND session is not private). If the
      // turn itself stayed WM-only, its annotations must too — otherwise
      // the hook would gossip a chat:mentions/proposes triple that
      // points back at a turn the team can't actually see.
      if (promote) {
        await postJson(cfg.api, `/api/assertion/${encodeURIComponent(applyAssertion)}/promote`, cfg.token, {
          contextGraphId: cfg.project,
          subGraphName: cfg.subGraph,
          entities: Array.from(promoteEntities),
        }).catch(() => { /* non-fatal */ });
      }
      applied++;
      log(`applied pending annotation ${pending} → ${turnUri} (${rewritten.length} triples)`);
    } catch (err) {
      log(`apply pending ${pending}: ${err?.message ?? err}`);
    }
  }
  return applied;
}

// ── Per-turn annotation reminder (Phase 7B) ───────────────────
//
// Session-start additionalContext gets ~5KB of protocol once, but
// LLMs weight recency and a 3-section directive at the top of context
// loses the war by turn 2. This is a tight (~400 char) per-turn
// reminder injected via beforeSubmitPrompt / UserPromptSubmit so it
// rides along with EVERY user turn. Empirically: turn-1 of a fresh
// chat skipped annotation despite alwaysApply: true on the rule, and
// the agent later self-annotated a chat:concludes Finding admitting
// the skip ("agent-skipped-dkg-annotate-turn-prior-reply-despite-..."
// — preserved at urn:dkg:finding:agent-skipped-...). This per-turn
// nudge closes that gap without bloating context.
export function buildPerTurnReminder(sessionKey) {
  return `**DKG annotation reminder (this turn):** after your reply, call \`dkg_annotate_turn\` with \`forSession: "${sessionKey}"\` and at minimum 2-3 \`topics\` plus \`mentions\` URIs from \`dkg_search\`. Required for every substantive turn (definition is broad — anything that reasoned, examined, proposed, or referenced something counts). Skipping is the failure mode. Full protocol: see session-start context + \`.cursor/rules/dkg-annotate.mdc\`.`;
}

// ── Mention-regex backstop ────────────────────────────────────
//
// Defensive: even if the agent forgets to call dkg_annotate_turn, any
// urn:dkg:* URI quoted verbatim in the prompt or response gets a
// chat:mentions edge from the turn. Cheap (one regex pass), deterministic,
// covers the most common case (agent referencing existing entities).
// Agent-emitted richer triples (chat:examines / chat:proposes / etc.)
// remain additive on top.
const URN_DKG_RE = /urn:dkg:[\w@:%./-]+(?:\/[\w@:%./-]+)*[\w%]/g;
export function extractMentionedUris(...texts) {
  const found = new Set();
  for (const t of texts) {
    if (!t) continue;
    const matches = String(t).match(URN_DKG_RE) ?? [];
    for (const m of matches) found.add(m.replace(/[.,;:)\]}>]+$/, ''));
  }
  return [...found];
}

// ── Event handlers ────────────────────────────────────────────
/**
 * Build the standard set of `chat:Session` triples for a sessionKey.
 * Factored out so sessionStart AND the afterAgentResponse safety net
 * can emit identical metadata. Relying on triple-store dedup for
 * idempotency — two writes with identical (s,p,o) are collapsed.
 */
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

async function handleSessionStart(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const existing = loadSessionState(sessionKey);
  const now = new Date().toISOString();
  const state = existing ?? {
    sessionKey,
    sessionUri: sessionUri(sessionKey),
    startedAt: now,
    turnIndex: 0,
    pendingPrompt: null,
    sessionWritten: false,
  };
  state.lastEventAt = now;

  if (!cfg.project) {
    log('no project configured — skipping session write');
    saveSessionState(sessionKey, state);
    return;
  }
  await ensureSubGraph(cfg);
  try {
    await writeTriples(cfg, sessionTriples(cfg, state, payload));
    state.sessionWritten = true;
    // Same privacy gate as the turn write below — a session marked
    // private at session-start (workspace default `capture.privacy:
    // private`) MUST NOT have even its Session entity gossiped.
    // Matches the `await shouldPromote` pattern in handleAfterAgentResponse.
    if (await shouldPromote(cfg, state)) {
      await promoteEntities(cfg, [state.sessionUri]).catch((e) => log(`promote session: ${e.message}`));
    }
  } catch (err) {
    log(`session start write: ${err?.message ?? err}`);
  }
  // Self-register the agent in `meta` so attribution chips render
  // properly without a manual import-agents step. Idempotent.
  await selfRegisterAgent(cfg, state);
  saveSessionState(sessionKey, state);
}

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

  // Safety net: Cursor doesn't always fire sessionStart (e.g. when the
  // hook config is added mid-session, or on resumed threads). On the
  // first turn of a session whose Session triples haven't been written
  // yet, emit them alongside the turn so the UI / MCP always sees a
  // proper `chat:Session` entity pointing to `chat:Turn`s.
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
  // data. This is what unblocks us on day 0 before the spike tells us
  // the exact field names.
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

  // Mention-regex backstop (Phase 7): defensive auto-link for any
  // urn:dkg:* URI quoted verbatim in the prompt or response. Even if
  // the agent forgets to call dkg_annotate_turn, basic mentions still
  // land. Agent-emitted richer triples remain additive on top.
  for (const uri of extractMentionedUris(userText, asstText)) {
    triples.push({ subject: turn, predicate: P.mentions, object: URI(uri) });
  }

  let writeOk = false;
  const turnAssertion = perTurnAssertionName(cfg, sessionKey, idx);
  try {
    await writeTriples(cfg, triples, turnAssertion);
    writeOk = true;
    // Commit progress only on success — see comment above the `idx` calc.
    state.turnIndex = idx;
    state.pendingPrompt = null;
    if (bootstrapSession) state.sessionWritten = true;
    // Compute the promote-or-not decision ONCE per turn. `shouldPromote`
    // is async (it may hit /api/query to read `chat:privacy`), so a
    // bare `if (shouldPromote(...))` always-truthy the Promise and
    // leaks private turns into SWM. Do it right with an explicit
    // `await` and reuse the resolved boolean for annotation promote
    // below so both gates agree.
    const promote = await shouldPromote(cfg, state);
    if (promote) {
      // Promote both the session and the individual turn so the team
      // sees the turn immediately and the aggregate Session is kept
      // in SWM.
      await promoteEntities(cfg, [turn, state.sessionUri], turnAssertion).catch((e) => log(`promote turn: ${e.message}`));
    } else if (cfg.autoShare) {
      log(`auto-share skipped: session ${sessionKey} is private`);
    }
    log(`wrote turn #${idx} for session ${sessionKey}${bootstrapSession ? ' (bootstrapped session)' : ''}`);
    // Phase 7 race-fix: apply any pending annotations queued by
    // dkg_annotate_turn(forSession=...) during this response. Best-
    // effort, non-blocking on error — pendings can also be applied
    // later by re-running this hook on the next turn. Pass the same
    // promote decision so a private turn doesn't leak via annotations.
    try {
      const n = await applyPendingAnnotations(cfg, sessionKey, turn, promote);
      if (n > 0) log(`applied ${n} pending annotation${n === 1 ? '' : 's'} to ${turn}`);
    } catch (err) {
      log(`pending-annotation apply failed: ${err?.message ?? err}`);
    }
  } catch (err) {
    // Leave state.turnIndex + state.pendingPrompt untouched so the next
    // afterAgentResponse retries the same slot with the same prompt.
    log(`turn write failed (turn #${idx} not committed; will retry next event): ${err?.message ?? err}`);
  }

  state.lastEventAt = now;
  saveSessionState(sessionKey, state);
  return writeOk;
}

async function handleSessionEnd(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const state = loadSessionState(sessionKey);
  if (!state) return;
  const now = new Date().toISOString();
  state.endedAt = now;
  saveSessionState(sessionKey, state);
  if (!cfg.project) return;
  try {
    await writeTriples(cfg, [
      { subject: state.sessionUri, predicate: P.modified, object: LIT(now, NS.xsd + 'dateTime') },
    ]);
  } catch (err) {
    log(`session end write: ${err?.message ?? err}`);
  }
}

// ── Session-start additionalContext (Phase 7) ─────────────────
//
// Both Cursor's sessionStart and Claude Code's SessionStart support
// returning JSON with an `additionalContext` field whose markdown gets
// prepended to the agent's working context for the rest of the session.
// We use this to inject (a) a tight summary of the project's annotation
// protocol so the agent knows to call dkg_annotate_turn from turn #1,
// and (b) a short snapshot of recent entities so look-before-mint has
// candidates to match against without needing a separate dkg_search.
//
// Budget: ~600-800 tokens. Cheap relative to any modern context window.
async function buildSessionStartContext(cfg, sessionKey) {
  if (!cfg.project) return null;

  const RECENT_LIMIT = 30;
  let recentRows = [];
  try {
    const sparql = `
SELECT ?s ?type ?label WHERE {
  GRAPH ?g {
    ?s a ?type .
    OPTIONAL { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?label }
    FILTER(STRSTARTS(STR(?s), "urn:dkg:"))
    FILTER(?type IN (
      <http://dkg.io/ontology/decisions/Decision>,
      <http://dkg.io/ontology/tasks/Task>,
      <http://dkg.io/ontology/coding-project/Finding>,
      <http://dkg.io/ontology/coding-project/Question>,
      <http://www.w3.org/2004/02/skos/core#Concept>,
      <http://dkg.io/ontology/agent/Agent>,
      <http://dkg.io/ontology/agent/AIAgent>,
      <http://dkg.io/ontology/chat/Session>
    ))
  }
}
LIMIT ${RECENT_LIMIT}`;
    const r = await postJson(cfg.api, '/api/query', cfg.token, {
      sparql,
      contextGraphId: cfg.project,
      includeSharedMemory: true,
    });
    recentRows = r?.result?.bindings ?? [];
  } catch (err) {
    log(`buildSessionStartContext: recent-entities query failed: ${err.message}`);
  }

  // Phase 8: bucket recent entities by type so the agent's first-prompt
  // context reads as a project plan ("Open tasks: ...", "Decisions on
  // record: ...") rather than one flat list. Tasks come first because
  // they're what most coding sessions act on; decisions and concepts
  // give surrounding context. This is what makes the joiner's "agent
  // immediately knows what to do" moment land — the curator publishes
  // tasks via dkg_add_task, joiner's session start surfaces them by
  // bucket, agent picks one.
  const TYPE_BUCKETS = [
    { label: 'Open tasks',         match: /Task$/ },
    { label: 'Decisions on record', match: /Decision$/ },
    { label: 'Concepts in scope',   match: /(Concept|Topic)$/ },
    { label: 'Findings',            match: /Finding$/ },
    { label: 'Open questions',      match: /Question$/ },
    { label: 'Agents in this graph', match: /Agent$/ },
    { label: 'Recent chat sessions', match: /Session$/ },
  ];
  const buckets = new Map(TYPE_BUCKETS.map((b) => [b.label, []]));
  const otherBucket = [];
  for (const row of recentRows.slice(0, RECENT_LIMIT)) {
    const s = (row.s?.value ?? row.s ?? '').toString();
    const t = (row.type?.value ?? row.type ?? '').toString().replace(/^http:\/\/[^/]+\/[^#]+[#/]/, '');
    const l = (row.label?.value ?? row.label ?? '').toString().replace(/^"|"$/g, '');
    const line = `- \`${s}\`${l ? ` — ${l.slice(0, 100)}` : ''}`;
    const matched = TYPE_BUCKETS.find((b) => b.match.test(t));
    if (matched) buckets.get(matched.label).push(line);
    else otherBucket.push(`${line}${t ? ` _(${t})_` : ''}`);
  }
  const bucketSections = [];
  for (const { label } of TYPE_BUCKETS) {
    const lines = buckets.get(label);
    if (!lines.length) continue;
    bucketSections.push(`**${label}:**\n${lines.join('\n')}`);
  }
  if (otherBucket.length) {
    bucketSections.push(`**Other recent entities:**\n${otherBucket.join('\n')}`);
  }
  const recentLines = bucketSections.join('\n\n');

  const md = `## DKG project context — \`${cfg.project}\`

This workspace is bound to a DKG context graph. Every chat turn here is
captured into the project's \`chat\` sub-graph and gossipped to all
subscribed nodes. After every substantive turn, you SHOULD call
\`dkg_annotate_turn\` to emit structured triples about what the turn was
about — topics, mentions, examines, proposes, concludes, asks. The
chat sub-graph then becomes a navigable knowledge graph rather than
just a text log.

**Your current session ID:** \`${sessionKey}\`

When calling \`dkg_annotate_turn\`, ALWAYS pass \`forSession: "${sessionKey}"\`. The tool then queues your annotation as a "pending-annotation" entity, and the capture hook applies it to the actual turn URI when it writes the next chat:Turn for this session. **Race-free**: works whether you call annotate during your response composition (before the hook fires) or after. Do NOT try to predict your own turn URI — it doesn't exist yet at the moment you call this tool.

**Look-before-mint protocol** (the convergence rule):
1. Before minting any new \`urn:dkg:<type>:<slug>\` URI, call \`dkg_search\` with the unnormalised label.
2. If a result has the same normalised slug, REUSE its URI.
3. Slug rule: lowercase → ASCII-fold → strip stopwords (the/a/an/of/for/and/or/to/in/on/with) → hyphenate → ≤60 chars.
4. Only mint fresh if no match. Never fabricate URIs.

**Universal annotation primitives** (for any project type):
- \`chat:topic\` (literal) — short topical buckets
- \`chat:mentions\` (URI) — entities the turn referenced
- \`chat:examines\` (URI) — entities analysed in detail
- \`chat:proposes\` (URI) — ideas/decisions/tasks put forward
- \`chat:concludes\` (URI) — Findings worth preserving
- \`chat:asks\` (URI) — open Questions

Call \`dkg_get_ontology\` for the full agent guide + formal Turtle (one-time per session).

${recentLines.length ? `**Recent entities in this graph** (look here first before minting):\n\n${recentLines}\n` : '_(no recent entities found — graph is fresh)_'}
`;

  return md;
}

// ── Entry point ───────────────────────────────────────────────
// Only run when invoked as the main module — otherwise importing this
// file from a test (or any other module) would execute the IIFE and
// hit `process.exit(0)` before the importer can do anything. The
// vitest suite in `test/capture-hook.test.ts` relies on this guard.
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
  let response = {};
  try {
    switch (EVENT) {
      // Cursor native events + Claude Code equivalents:
      //   sessionStart        ≡ SessionStart       (session begins/resumes)
      //   beforeSubmitPrompt  ≡ UserPromptSubmit   (prompt stashed for turn)
      //   afterAgentResponse  ≡ Stop               (assistant finished responding)
      //   sessionEnd          ≡ SessionEnd         (session closes)
      case 'sessionStart':
      case 'SessionStart':
        await handleSessionStart(cfg, payload);
        // Inject ontology summary + recent entities so the agent boots
        // already knowing the annotation protocol + graph state. Both
        // Cursor and Claude Code honour `additionalContext` in the
        // sessionStart hook response (top-level field, markdown body).
        try {
          const sessionKey = extractSessionKey(payload);
          const ctxMd = await buildSessionStartContext(cfg, sessionKey);
          if (ctxMd) {
            // Cursor and Claude Code disagree on the field name; emit
            // all three shapes so neither tool drops the injection.
            //   - Cursor:      `additional_context` (snake_case) per
            //                  cursor.com/docs/agent/third-party-hooks
            //   - Claude Code: `hookSpecificOutput.additionalContext`
            //                  (canonical) + top-level `additionalContext`
            //                  fallback per docs.claude.com/en/docs/claude-code/hooks
            response.additional_context = ctxMd;          // Cursor
            response.additionalContext = ctxMd;            // Claude Code top-level
            response.hookSpecificOutput = {                // Claude Code canonical
              hookEventName: 'SessionStart',
              additionalContext: ctxMd,
            };
            log(`injected session-start additionalContext (${ctxMd.length} chars)`);
          }
        } catch (err) {
          log(`session-start context injection: ${err?.message ?? err}`);
        }
        break;
      case 'beforeSubmitPrompt':
      case 'UserPromptSubmit':
        await handleBeforeSubmitPrompt(cfg, payload);
        // Phase 7B: per-turn annotation reminder. The two tools
        // disagree on the field name(!):
        //   - Cursor's beforeSubmitPrompt expects `additional_context`
        //     (snake_case), per https://cursor.com/docs/agent/third-party-hooks
        //   - Claude Code's UserPromptSubmit expects `additionalContext`
        //     inside `hookSpecificOutput`, plus accepts top-level
        //     `additionalContext` per docs.claude.com/en/docs/claude-code/hooks
        // Emit all three shapes defensively so neither tool drops the
        // injection. The markdown is prepended to the conversation's
        // system context for the upcoming user message — recency-
        // weighted nudge that survives across turns (session-start
        // injection alone wasn't enough; the agent skipped annotation
        // on early turns despite alwaysApply: true on the rule).
        if (cfg.project) {
          try {
            const sessionKey = extractSessionKey(payload);
            const reminder = buildPerTurnReminder(sessionKey);
            response.additional_context = reminder;     // Cursor
            response.additionalContext = reminder;       // Claude Code (top-level fallback)
            response.hookSpecificOutput = {              // Claude Code (canonical)
              hookEventName: EVENT === 'UserPromptSubmit' ? 'UserPromptSubmit' : 'beforeSubmitPrompt',
              additionalContext: reminder,
            };
          } catch (err) {
            log(`per-turn reminder injection: ${err?.message ?? err}`);
          }
        }
        break;
      case 'afterAgentResponse':
      case 'Stop':
        await handleAfterAgentResponse(cfg, payload);
        break;
      case 'sessionEnd':
      case 'SessionEnd':
        await handleSessionEnd(cfg, payload);
        break;
      default:
        log(`unknown event: ${EVENT}`);
    }
  } catch (err) {
    log(`handler error: ${err?.stack ?? err?.message ?? err}`);
  }
  process.stdout.write(JSON.stringify(response) + '\n');
  process.exit(0);
})();
